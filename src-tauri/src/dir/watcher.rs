use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt};
use rayon::prelude::*;
use tauri::{AppHandle, Runtime};
use tauri_specta::Event as _;

use super::lister::build_entry;
use crate::error::{AppError, AppResult};
use crate::model::{DirChanged, FileEntry};

/// Short enough to feel live (plan DoD: < 300 ms), long enough to coalesce a
/// burst like `git checkout` into a few events.
const DEBOUNCE: Duration = Duration::from_millis(80);

/// A directory being watched, keyed by its canonical path because FSEvents
/// reports real paths (`/private/tmp/x` for `/tmp/x`).
struct Watched {
    /// Path as the frontend asked for it; events are reported against this.
    requested: PathBuf,
    refs: usize,
}

type Registry = Arc<Mutex<HashMap<PathBuf, Watched>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Registry state stays consistent even if a holder panicked.
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Non-recursive, ref-counted directory watching (one pane or tab = one ref).
pub struct DirWatcher {
    debouncer: Mutex<Debouncer<RecommendedWatcher, NoCache>>,
    registry: Registry,
}

impl DirWatcher {
    pub fn new<R: Runtime>(app: AppHandle<R>) -> notify::Result<Self> {
        let registry: Registry = Arc::default();
        let reg = Arc::clone(&registry);
        // NoCache: the default file-id cache walks every watched directory up front,
        // which is wasted work here since changed children are re-stat'ed anyway.
        let debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            move |result: DebounceEventResult| match result {
                Ok(events) => {
                    for change in collect_changes(&reg, &events) {
                        if let Err(e) = change.emit(&app) {
                            log::warn!("dir-changed not delivered: {e}");
                        }
                    }
                }
                Err(errors) => errors.iter().for_each(|e| log::warn!("watcher error: {e}")),
            },
            NoCache,
            notify::Config::default(),
        )?;
        Ok(Self { debouncer: Mutex::new(debouncer), registry })
    }

    pub fn watch(&self, dir: &Path) -> AppResult<()> {
        let canonical = fs::canonicalize(dir).map_err(|e| AppError::from_io(&e, dir))?;
        let mut reg = lock(&self.registry);
        if let Some(w) = reg.get_mut(&canonical) {
            w.refs += 1;
            return Ok(());
        }
        lock(&self.debouncer).watch(&canonical, RecursiveMode::NonRecursive).map_err(|e| AppError::Io {
            path: Some(dir.to_string_lossy().into_owned()),
            message: e.to_string(),
        })?;
        reg.insert(canonical, Watched { requested: dir.to_path_buf(), refs: 1 });
        Ok(())
    }

    pub fn unwatch(&self, dir: &Path) {
        let mut reg = lock(&self.registry);
        // The directory may be gone by now; fall back to matching the requested path.
        let key = fs::canonicalize(dir)
            .ok()
            .filter(|c| reg.contains_key(c))
            .or_else(|| reg.iter().find(|(_, w)| w.requested == dir).map(|(k, _)| k.clone()));
        let Some(key) = key else { return };
        let Some(w) = reg.get_mut(&key) else { return };
        w.refs -= 1;
        if w.refs == 0 {
            reg.remove(&key);
            if let Err(e) = lock(&self.debouncer).unwatch(&key) {
                log::debug!("unwatch {}: {e}", key.display());
            }
        }
    }
}

#[derive(Default)]
struct Pending {
    children: HashSet<PathBuf>,
    rescan: bool,
}

/// Groups raw events by watched directory and re-stats each touched child, so
/// the frontend gets ready-to-use entries instead of event kinds to interpret.
fn collect_changes(registry: &Registry, events: &[DebouncedEvent]) -> Vec<DirChanged> {
    let reg = lock(registry);
    let mut pending: HashMap<PathBuf, Pending> = HashMap::new();

    for ev in events {
        if matches!(ev.kind, EventKind::Access(_)) {
            continue;
        }
        for path in &ev.paths {
            if ev.need_rescan() {
                let dir = if reg.contains_key(path) { Some(path.as_path()) } else { path.parent() };
                if let Some(dir) = dir.filter(|d| reg.contains_key(*d)) {
                    pending.entry(dir.to_path_buf()).or_default().rescan = true;
                }
            } else if reg.contains_key(path) {
                // The watched directory itself was renamed/removed/re-permissioned. Its
                // own creation is just FSEvents replaying history right after `watch`.
                if !matches!(ev.kind, EventKind::Create(_)) {
                    pending.entry(path.clone()).or_default().rescan = true;
                }
            } else if let Some(parent) = path.parent().filter(|p| reg.contains_key(*p)) {
                pending.entry(parent.to_path_buf()).or_default().children.insert(path.clone());
            }
        }
    }

    let requested: HashMap<PathBuf, PathBuf> =
        pending.keys().filter_map(|k| reg.get(k).map(|w| (k.clone(), w.requested.clone()))).collect();
    drop(reg);

    pending
        .into_iter()
        .filter_map(|(canonical, p)| {
            let dir = requested.get(&canonical)?;
            Some(build_change(dir, p))
        })
        .collect()
}

fn build_change(dir: &Path, pending: Pending) -> DirChanged {
    if pending.rescan {
        return DirChanged {
            dir: dir.to_string_lossy().into_owned(),
            upserted: vec![],
            removed: vec![],
            rescan: true,
        };
    }
    // Report children under the path the frontend uses, not the canonical one.
    let results: Vec<Result<FileEntry, String>> = pending
        .children
        .par_iter()
        .filter_map(|child| {
            let name = child.file_name()?;
            let path = dir.join(name);
            Some(match fs::symlink_metadata(&path) {
                Ok(meta) => Ok(build_entry(name.to_string_lossy().into_owned(), &path, &meta, true)),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Err(path.to_string_lossy().into_owned()),
                // Unreadable but present: keep whatever the frontend already shows.
                Err(_) => return None,
            })
        })
        .collect();
    let (upserted, removed): (Vec<_>, Vec<_>) = results.into_iter().partition(Result::is_ok);
    DirChanged {
        dir: dir.to_string_lossy().into_owned(),
        upserted: upserted.into_iter().filter_map(Result::ok).collect(),
        removed: removed.into_iter().filter_map(Result::err).collect(),
        rescan: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, RemoveKind};
    use std::time::Instant;

    fn event(kind: EventKind, path: PathBuf) -> DebouncedEvent {
        DebouncedEvent::new(notify::Event::new(kind).add_path(path), Instant::now())
    }

    #[test]
    fn maps_events_to_entries_under_requested_path() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = fs::canonicalize(tmp.path()).unwrap();
        // Pretend the user navigated via a symlinked spelling of the same directory.
        let requested = PathBuf::from("/requested/spelling");
        let registry: Registry = Arc::default();
        lock(&registry).insert(canonical.clone(), Watched { requested: requested.clone(), refs: 1 });

        fs::write(canonical.join("new.txt"), "x").unwrap();
        let events = vec![
            event(EventKind::Create(CreateKind::File), canonical.join("new.txt")),
            event(EventKind::Remove(RemoveKind::File), canonical.join("gone.txt")),
            event(EventKind::Create(CreateKind::File), PathBuf::from("/elsewhere/x")),
        ];
        let changes = collect_changes(&registry, &events);
        assert_eq!(changes.len(), 1);
        let c = &changes[0];
        assert_eq!(c.dir, "/requested/spelling");
        assert!(!c.rescan);
        // `/requested/spelling` doesn't exist, so both children read as removed —
        // which proves paths are rebased onto the requested spelling.
        let mut removed = c.removed.clone();
        removed.sort();
        assert_eq!(removed, vec!["/requested/spelling/gone.txt", "/requested/spelling/new.txt"]);
    }

    #[test]
    fn stats_real_children() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        let registry: Registry = Arc::default();
        lock(&registry).insert(dir.clone(), Watched { requested: dir.clone(), refs: 1 });
        fs::write(dir.join("a.txt"), "abc").unwrap();

        let changes =
            collect_changes(&registry, &[event(EventKind::Create(CreateKind::Folder), dir.clone())]);
        assert!(changes.is_empty(), "replayed creation of the watched dir is ignored");

        let changes = collect_changes(
            &registry,
            &[
                event(EventKind::Create(CreateKind::File), dir.join("a.txt")),
                event(EventKind::Remove(RemoveKind::Folder), dir.clone()),
            ],
        );
        assert_eq!(changes.len(), 1);
        // The directory itself changing wins: rescan instead of a partial delta.
        assert!(changes[0].rescan);

        let changes =
            collect_changes(&registry, &[event(EventKind::Create(CreateKind::File), dir.join("a.txt"))]);
        assert_eq!(changes[0].upserted.len(), 1);
        assert_eq!(changes[0].upserted[0].size, 3);
    }

    #[test]
    fn live_watch_reports_creation() {
        use std::sync::mpsc;

        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            move |r: DebounceEventResult| {
                let _ = tx.send(r);
            },
            NoCache,
            notify::Config::default(),
        )
        .unwrap();
        debouncer.watch(&dir, RecursiveMode::NonRecursive).unwrap();
        std::thread::sleep(Duration::from_millis(200));

        let started = Instant::now();
        fs::write(dir.join("hello.txt"), "hi").unwrap();
        // FSEvents may first replay the directory's own creation; wait for our file.
        let latency = loop {
            let events = rx.recv_timeout(Duration::from_secs(5)).expect("no event").unwrap();
            if events.iter().any(|e| e.paths.iter().any(|p| p.ends_with("hello.txt"))) {
                break started.elapsed();
            }
        };
        assert!(latency < Duration::from_millis(1000), "latency {latency:?}");
        eprintln!("watch latency: {latency:?}");
    }
}
