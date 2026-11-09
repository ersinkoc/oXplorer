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
    /// Panes / tabs watching it, counted per window (so a closed window lets
    /// go) and per spelling the frontend asked for (`/tmp/x`, `/private/tmp/x`,
    /// `~/desktop`): events are reported against every spelling in use.
    refs: HashMap<(String, PathBuf), usize>,
    /// The folder was deleted: its creation is real again, not a replay.
    gone: bool,
}

impl Watched {
    fn new(requested: &Path, window: &str) -> Self {
        Self { refs: HashMap::from([((window.to_owned(), requested.to_path_buf()), 1)]), gone: false }
    }

    fn spellings(&self) -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = self.refs.keys().map(|(_, p)| p.clone()).collect();
        paths.sort();
        paths.dedup();
        paths
    }
}

type Registry = Arc<Mutex<HashMap<PathBuf, Watched>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // Registry state stays consistent even if a holder panicked.
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Non-recursive, ref-counted directory watching (one pane or tab = one ref,
/// counted per window).
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

    pub fn watch(&self, dir: &Path, window: &str) -> AppResult<()> {
        let canonical = fs::canonicalize(dir).map_err(|e| AppError::from_io(&e, dir))?;
        let mut reg = lock(&self.registry);
        if let Some(w) = reg.get_mut(&canonical) {
            *w.refs.entry((window.to_owned(), dir.to_path_buf())).or_default() += 1;
            return Ok(());
        }
        lock(&self.debouncer).watch(&canonical, RecursiveMode::NonRecursive).map_err(|e| AppError::Io {
            path: Some(dir.to_string_lossy().into_owned()),
            message: e.to_string(),
        })?;
        reg.insert(canonical, Watched::new(dir, window));
        Ok(())
    }

    pub fn unwatch(&self, dir: &Path, window: &str) {
        let mut reg = lock(&self.registry);
        // The directory may be gone by now; fall back to matching the requested path.
        let key = fs::canonicalize(dir).ok().filter(|c| reg.contains_key(c)).or_else(|| {
            reg.iter().find(|(_, w)| w.refs.keys().any(|(_, p)| p == dir)).map(|(k, _)| k.clone())
        });
        let Some(key) = key else { return };
        let Some(w) = reg.get_mut(&key) else { return };
        let slot = (window.to_owned(), dir.to_path_buf());
        if let Some(n) = w.refs.get_mut(&slot) {
            *n -= 1;
            if *n == 0 {
                w.refs.remove(&slot);
            }
        }
        if w.refs.is_empty() {
            reg.remove(&key);
            self.stop(&key);
        }
    }

    /// Drops everything a closed window was watching.
    pub fn release_window(&self, window: &str) {
        let mut reg = lock(&self.registry);
        reg.retain(|key, w| {
            w.refs.retain(|(w, _), _| w != window);
            if w.refs.is_empty() {
                self.stop(key);
                return false;
            }
            true
        });
    }

    fn stop(&self, key: &Path) {
        if let Err(e) = lock(&self.debouncer).unwatch(key) {
            log::debug!("unwatch {}: {e}", key.display());
        }
    }
}

#[derive(Default, Clone)]
struct Pending {
    children: HashSet<PathBuf>,
    rescan: bool,
}

/// Groups raw events by watched directory and re-stats each touched child, so
/// the frontend gets ready-to-use entries instead of event kinds to interpret.
fn collect_changes(registry: &Registry, events: &[DebouncedEvent]) -> Vec<DirChanged> {
    let mut reg = lock(registry);
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
            } else if let Some(w) = reg.get_mut(path) {
                // The watched directory itself was renamed/removed/re-permissioned. Its
                // own creation is FSEvents replaying history right after `watch`,
                // unless it was deleted before: then it was made again.
                if !matches!(ev.kind, EventKind::Create(_)) || w.gone {
                    w.gone = fs::symlink_metadata(path).is_err();
                    pending.entry(path.clone()).or_default().rescan = true;
                }
            } else if let Some(parent) = path.parent().filter(|p| reg.contains_key(*p)) {
                pending.entry(parent.to_path_buf()).or_default().children.insert(path.clone());
            }
        }
    }

    let spellings: HashMap<PathBuf, Vec<PathBuf>> =
        pending.keys().filter_map(|k| reg.get(k).map(|w| (k.clone(), w.spellings()))).collect();
    drop(reg);

    pending
        .into_iter()
        .flat_map(|(canonical, p)| {
            let dirs = spellings.get(&canonical).cloned().unwrap_or_default();
            dirs.into_iter().map(move |dir| build_change(&dir, p.clone()))
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
    // Each child gives an entry to show and/or a path to drop.
    let results: Vec<(Option<FileEntry>, Option<String>)> = pending
        .children
        .par_iter()
        .filter_map(|child| {
            let name = child.file_name()?;
            let path = dir.join(name);
            Some(match fs::symlink_metadata(&path) {
                Ok(meta) => match stored_name(&path) {
                    // APFS finds a name in any case or Unicode form, so the old
                    // spelling of a case-only rename still stats: show the item
                    // under the name it has now and drop the old spelling.
                    Ok(stored) if stored != name => {
                        let now = dir.join(&stored);
                        let entry = build_entry(stored.to_string_lossy().into_owned(), &now, &meta, true);
                        (Some(entry), Some(path.to_string_lossy().into_owned()))
                    }
                    _ => (Some(build_entry(name.to_string_lossy().into_owned(), &path, &meta, true)), None),
                },
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    (None, Some(path.to_string_lossy().into_owned()))
                }
                // Unreadable but present: keep whatever the frontend already shows.
                Err(_) => return None,
            })
        })
        .collect();
    let mut upserted: Vec<FileEntry> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    for (entry, gone) in results {
        if let Some(e) = entry.filter(|e| !upserted.iter().any(|u| u.path == e.path)) {
            upserted.push(e);
        }
        removed.extend(gone);
    }
    removed.retain(|p| !upserted.iter().any(|u| &u.path == p));
    DirChanged { dir: dir.to_string_lossy().into_owned(), upserted, removed, rescan: false }
}

/// The name the file system stores for `path`'s last component (symlinks not followed).
fn stored_name(path: &Path) -> io::Result<std::ffi::OsString> {
    use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
    // The u32 length, an attrreference_t, then the name (up to 255 UTF-16
    // units of NFD text, at most 3 bytes each) and its NUL.
    #[repr(C, align(4))]
    struct Buf([u8; 4 + 8 + 1024]);
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: attrlist is plain data; all-zero is a valid empty request.
    let mut list: libc::attrlist = unsafe { std::mem::zeroed() };
    list.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    list.commonattr = libc::ATTR_CMN_NAME;
    let mut buf = Buf([0; 4 + 8 + 1024]);
    // SAFETY: `c` is NUL-terminated, `list` and `buf` outlive the call, and the
    // size passed is the buffer's own.
    let rc = unsafe {
        libc::getattrlist(
            c.as_ptr(),
            (&raw mut list).cast(),
            buf.0.as_mut_ptr().cast(),
            buf.0.len(),
            libc::FSOPT_NOFOLLOW,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    let word = |at: usize| buf.0.get(at..at + 4).and_then(|b| b.try_into().ok()).map(u32::from_ne_bytes);
    let bad = || io::Error::from(io::ErrorKind::InvalidData);
    // attr_dataoffset is relative to the attrreference_t itself (at byte 4).
    let offset = usize::try_from(word(4).ok_or_else(bad)?).map_err(|_| bad())?;
    let length = usize::try_from(word(8).ok_or_else(bad)?).map_err(|_| bad())?;
    let start = 4 + offset;
    let bytes = buf.0.get(start..start + length).ok_or_else(bad)?;
    let name = bytes.split(|b| *b == 0).next().unwrap_or_default();
    Ok(std::ffi::OsString::from_vec(name.to_vec()))
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
    fn a_case_only_rename_leaves_one_entry() {
        use notify::event::{ModifyKind, RenameMode};
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        let registry: Registry = Arc::default();
        lock(&registry).insert(dir.clone(), Watched::new(&dir, "main"));
        let renamed = |from: &str, to: &str| {
            fs::write(dir.join(from), "x").unwrap();
            fs::rename(dir.join(from), dir.join(to)).unwrap();
            let kind = EventKind::Modify(ModifyKind::Name(RenameMode::Any));
            let c = collect_changes(&registry, &[event(kind, dir.join(from)), event(kind, dir.join(to))]);
            fs::remove_file(dir.join(to)).unwrap();
            let names: Vec<String> = c[0].upserted.iter().map(|e| e.name.clone()).collect();
            let removed: Vec<String> =
                c[0].removed.iter().map(|p| p.rsplit('/').next().unwrap().to_owned()).collect();
            (names, removed)
        };
        // Control: a rename to another name.
        assert_eq!(renamed("a.txt", "b.txt"), (vec!["b.txt".to_owned()], vec!["a.txt".to_owned()]));
        // Only the case, or only the Unicode form, changes: the old spelling still stats.
        assert_eq!(renamed("c.txt", "C.txt"), (vec!["C.txt".to_owned()], vec!["c.txt".to_owned()]));
        assert_eq!(
            renamed("caf\u{e9}.txt", "cafe\u{301}.txt"),
            (vec!["cafe\u{301}.txt".to_owned()], vec!["caf\u{e9}.txt".to_owned()])
        );

        let kind = EventKind::Modify(ModifyKind::Any);
        let one = |name: &str| {
            let c = collect_changes(&registry, &[event(kind, dir.join(name))]);
            let names: Vec<String> = c[0].upserted.iter().map(|e| e.name.clone()).collect();
            let removed: Vec<String> =
                c[0].removed.iter().map(|p| p.rsplit('/').next().unwrap().to_owned()).collect();
            (names, removed)
        };
        // The old spelling alone, in a later batch.
        fs::write(dir.join("D.txt"), "x").unwrap();
        assert_eq!(one("d.txt"), (vec!["D.txt".to_owned()], vec!["d.txt".to_owned()]));
        // A file changed in place, and one deleted.
        assert_eq!(one("D.txt"), (vec!["D.txt".to_owned()], vec![]));
        fs::remove_file(dir.join("D.txt")).unwrap();
        assert_eq!(one("D.txt"), (vec![], vec!["D.txt".to_owned()]));
        // A symlink keeps its own name, not its target's.
        fs::write(dir.join("Target"), "x").unwrap();
        std::os::unix::fs::symlink("Target", dir.join("Link")).unwrap();
        assert_eq!(one("Link"), (vec!["Link".to_owned()], vec![]));
        assert_eq!(one("link"), (vec!["Link".to_owned()], vec!["link".to_owned()]));
    }

    #[test]
    fn maps_events_to_entries_under_requested_path() {
        let tmp = tempfile::tempdir().unwrap();
        let canonical = fs::canonicalize(tmp.path()).unwrap();
        // Pretend the user navigated via a symlinked spelling of the same directory.
        let requested = PathBuf::from("/requested/spelling");
        let registry: Registry = Arc::default();
        lock(&registry).insert(canonical.clone(), Watched::new(&requested, "main"));

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
        lock(&registry).insert(dir.clone(), Watched::new(&dir, "main"));
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
    fn every_spelling_in_use_gets_the_change() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap();
        let link = tmp.path().join("..").join(format!("ox-link-{}", std::process::id()));
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        let registry: Registry = Arc::default();
        let mut watched = Watched::new(&dir, "main");
        *watched.refs.entry(("window-2".to_owned(), link.clone())).or_default() += 1;
        lock(&registry).insert(dir.clone(), watched);
        fs::write(dir.join("a.txt"), "x").unwrap();
        let dirs = |reg: &Registry| {
            let mut d: Vec<String> =
                collect_changes(reg, &[event(EventKind::Create(CreateKind::File), dir.join("a.txt"))])
                    .into_iter()
                    .map(|c| {
                        assert_eq!(c.upserted.len(), 1);
                        c.dir
                    })
                    .collect();
            d.sort();
            d
        };
        let mut both = vec![dir.to_string_lossy().into_owned(), link.to_string_lossy().into_owned()];
        both.sort();
        assert_eq!(dirs(&registry), both);
        // The second spelling let go: only the first is reported.
        lock(&registry).get_mut(&dir).unwrap().refs.remove(&("window-2".to_owned(), link.clone()));
        assert_eq!(dirs(&registry), vec![dir.to_string_lossy().into_owned()]);
        fs::remove_file(&link).unwrap();
    }

    #[test]
    fn a_watched_folder_made_again_is_listed_again() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = fs::canonicalize(tmp.path()).unwrap().join("dist");
        fs::create_dir(&dir).unwrap();
        let registry: Registry = Arc::default();
        lock(&registry).insert(dir.clone(), Watched::new(&dir, "main"));
        let rescans = |kind| {
            collect_changes(&registry, &[event(kind, dir.clone())]).iter().filter(|c| c.rescan).count()
        };
        // Control: FSEvents replaying the folder's creation right after `watch`.
        assert_eq!(rescans(EventKind::Create(CreateKind::Folder)), 0);
        // `rm -rf dist`: the pane re-lists and shows "can't be found".
        fs::remove_dir(&dir).unwrap();
        assert_eq!(rescans(EventKind::Remove(RemoveKind::Folder)), 1);
        // `mkdir dist`: the pane must list it again.
        fs::create_dir(&dir).unwrap();
        assert_eq!(
            rescans(EventKind::Create(CreateKind::Folder)),
            1,
            "a recreated folder stays on its error"
        );
        // Once listed, a later replay is ignored again.
        assert_eq!(rescans(EventKind::Create(CreateKind::Folder)), 0);
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
