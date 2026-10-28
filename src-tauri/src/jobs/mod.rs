//! Long-running file operations: one thread per job, progress over a Channel,
//! cooperative cancellation, and conflict prompts answered by the frontend.

pub(crate) mod archive;
mod fsops;
mod names;
mod rename;
mod run;
mod types;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use tauri::State;
use tauri::ipc::Channel;
pub use types::*;

use crate::dir::build_entry_for;
use crate::error::{AppError, AppResult};
use crate::model::FileEntry;
use crate::security::validate_path;

/// Progress events are throttled to roughly this rate.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Where the paused job waits for the user's conflict answer.
type ConflictSlot = Arc<Mutex<Option<SyncSender<ConflictResolution>>>>;

struct Handle {
    cancel: Arc<AtomicBool>,
    conflict: ConflictSlot,
}

#[derive(Default)]
pub struct JobManager {
    jobs: Mutex<HashMap<String, Handle>>,
    /// Cancels that arrived before their job registered (the page cancels right after starting).
    early_cancels: Mutex<HashSet<String>>,
}

/// Unclaimed early cancels kept at most (ids of jobs that never started).
const EARLY_CANCELS: usize = 256;

impl JobManager {
    fn register(&self, id: &str) -> AppResult<(Arc<AtomicBool>, ConflictSlot)> {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        if jobs.contains_key(id) {
            return Err(AppError::AlreadyExists { path: format!("job {id}") });
        }
        let early = self.early_cancels.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
        let cancel = Arc::new(AtomicBool::new(early));
        let conflict = Arc::new(Mutex::new(None));
        jobs.insert(id.to_owned(), Handle { cancel: Arc::clone(&cancel), conflict: Arc::clone(&conflict) });
        Ok((cancel, conflict))
    }

    fn cancel(&self, id: String) {
        // Checked and remembered under the jobs lock, so `register` can't slip in between.
        let jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(h) = jobs.get(&id) {
            h.cancel.store(true, Ordering::Relaxed);
            return;
        }
        let mut early = self.early_cancels.lock().unwrap_or_else(PoisonError::into_inner);
        if early.len() >= EARLY_CANCELS {
            early.clear();
        }
        early.insert(id);
    }

    fn unregister(&self, id: &str) {
        self.jobs.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
    }
}

struct ChannelReporter {
    channel: Channel<JobEvent>,
    cancel: Arc<AtomicBool>,
    conflict: ConflictSlot,
    last_progress: Option<Instant>,
}

impl run::Reporter for ChannelReporter {
    fn planned(&mut self, total_bytes: u64, total_items: u32) {
        let _ = self.channel.send(JobEvent::Planned { total_bytes, total_items });
    }

    fn progress(&mut self, done_bytes: u64, done_items: u32, current: &Path) {
        if self.last_progress.is_some_and(|t| t.elapsed() < PROGRESS_INTERVAL) {
            return;
        }
        self.last_progress = Some(Instant::now());
        let current = current.to_string_lossy().into_owned();
        let _ = self.channel.send(JobEvent::Progress { done_bytes, done_items, current });
    }

    fn conflict(&mut self, source: &Path, existing: &Path) -> ConflictResolution {
        let stop = ConflictResolution { choice: ConflictChoice::Stop, apply_to_all: true };
        let (Some(source), Some(existing)) = (build_entry_for(source), build_entry_for(existing)) else {
            return stop;
        };
        let (tx, rx) = mpsc::sync_channel(1);
        *self.conflict.lock().unwrap_or_else(PoisonError::into_inner) = Some(tx);
        if self
            .channel
            .send(JobEvent::Conflict { source: Box::new(source), existing: Box::new(existing) })
            .is_err()
        {
            return stop;
        }
        // Wait for the user, but keep honoring cancel.
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(res) => return res,
                Err(RecvTimeoutError::Timeout) if !self.cancelled() => {}
                Err(_) => return stop,
            }
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/// Starts a job and returns immediately; everything else arrives on `on_event`,
/// ending with exactly one `Finished`.
#[tauri::command]
#[specta::specta]
pub fn start_job(
    jobs: State<'_, Arc<JobManager>>,
    id: String,
    spec: JobSpec,
    on_event: Channel<JobEvent>,
) -> AppResult<()> {
    let (cancel, conflict) = jobs.register(&id)?;
    let manager = Arc::clone(&jobs);
    std::thread::Builder::new()
        .name(format!("job-{id}"))
        .spawn(move || {
            let mut reporter =
                ChannelReporter { channel: on_event.clone(), cancel, conflict, last_progress: None };
            let outcome = run::run(spec, &mut reporter).unwrap_or_else(|error| JobOutcome {
                failures: vec![JobFailure { path: String::new(), error }],
                ..JobOutcome::default()
            });
            let _ = on_event.send(JobEvent::Finished { outcome });
            manager.unregister(&id);
        })
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn cancel_job(jobs: State<'_, Arc<JobManager>>, id: String) {
    jobs.cancel(id);
}

#[tauri::command]
#[specta::specta]
pub fn resolve_conflict(jobs: State<'_, Arc<JobManager>>, id: String, resolution: ConflictResolution) {
    if let Some(h) = jobs.jobs.lock().unwrap_or_else(PoisonError::into_inner).get(&id)
        && let Some(tx) = h.conflict.lock().unwrap_or_else(PoisonError::into_inner).take()
    {
        let _ = tx.send(resolution);
    }
}

/// Total size of `paths` (recursively), cancellable via `cancel_job(id)`.
#[tauri::command]
#[specta::specta]
pub async fn measure(
    jobs: State<'_, Arc<JobManager>>,
    id: String,
    paths: Vec<String>,
    on_event: Channel<MeasureEvent>,
) -> AppResult<()> {
    let paths = paths.iter().map(|p| validate_path(p)).collect::<AppResult<Vec<_>>>()?;
    let (cancel, _) = jobs.register(&id)?;
    let manager = Arc::clone(&jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let size = fsops::measure(&paths, &mut |size| {
            let _ = on_event.send(MeasureEvent::Progress { size: *size });
            !cancel.load(Ordering::Relaxed)
        });
        if let Some(size) = size {
            let _ = on_event.send(MeasureEvent::Done { size });
        }
        manager.unregister(&id);
    });
    Ok(())
}

/// SHA-256 of a file as lowercase hex (Get Info). Cancel with `cancel_job(id)`.
#[tauri::command]
#[specta::specta]
pub async fn checksum(jobs: State<'_, Arc<JobManager>>, id: String, path: String) -> AppResult<String> {
    let p = validate_path(&path)?;
    let (cancel, _) = jobs.register(&id)?;
    let manager = Arc::clone(&jobs);
    let result = tauri::async_runtime::spawn_blocking(move || sha256_hex(&p, &cancel))
        .await
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() });
    manager.unregister(&id);
    result?
}

fn sha256_hex(path: &Path, cancel: &AtomicBool) -> AppResult<String> {
    use sha2::{Digest as _, Sha256};
    use std::io::Read as _;
    let mut file = fs::File::open(path).map_err(|e| AppError::from_io(&e, path))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let n = file.read(&mut buf).map_err(|e| AppError::from_io(&e, path))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Renames in place. Case-only renames (`a.txt` → `A.txt`) work on case-insensitive volumes.
#[tauri::command]
#[specta::specta]
pub async fn rename_path(path: String, new_name: String) -> AppResult<FileEntry> {
    let src = validate_path(&path)?;
    names::validate_name(&new_name)
        .map_err(|reason| AppError::InvalidPath { path: new_name.clone(), reason: reason.into() })?;
    let dst = src.parent().unwrap_or(Path::new("/")).join(&new_name);
    tauri::async_runtime::spawn_blocking(move || {
        if dst != src
            && let Ok(existing) = fs::symlink_metadata(&dst)
        {
            // Same inode = the "existing" item is the source under another case.
            let same = fs::symlink_metadata(&src).is_ok_and(|m| {
                use std::os::unix::fs::MetadataExt as _;
                m.ino() == existing.ino() && m.dev() == existing.dev()
            });
            if !same {
                return Err(AppError::AlreadyExists { path: dst.to_string_lossy().into_owned() });
            }
        }
        fs::rename(&src, &dst).map_err(|e| AppError::from_io(&e, &src))?;
        build_entry_for(&dst).ok_or_else(|| AppError::NotFound { path: dst.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

/// A single name the user typed (no `/`, not `..`), as an `AppError` when invalid.
pub fn check_name(name: &str) -> AppResult<()> {
    names::validate_name(name)
        .map_err(|reason| AppError::InvalidPath { path: name.to_owned(), reason: reason.into() })
}

/// Renames several items at once; all or nothing.
#[tauri::command]
#[specta::specta]
pub async fn batch_rename(items: Vec<rename::RenameItem>) -> AppResult<rename::BatchRenameOutcome> {
    tauri::async_runtime::spawn_blocking(move || rename::batch_rename(&items))
        .await
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Creates `name` (or `name 2`, … if taken) inside `parent`.
#[tauri::command]
#[specta::specta]
pub async fn create_item(parent: String, name: String, folder: bool) -> AppResult<FileEntry> {
    let dir = validate_path(&parent)?;
    names::validate_name(&name)
        .map_err(|reason| AppError::InvalidPath { path: name.clone(), reason: reason.into() })?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = names::untitled(&dir, &name, !folder);
        let res = if folder {
            fs::create_dir(&path)
        } else {
            fs::OpenOptions::new().write(true).create_new(true).open(&path).map(drop)
        };
        res.map_err(|e| AppError::from_io(&e, &path))?;
        build_entry_for(&path).ok_or_else(|| AppError::NotFound { path: path.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| AppError::Io { path: Some(parent), message: e.to_string() })?
}

/// Make Alias: a symbolic link to `target` next to it, named `name` (or `name 2`, …).
#[tauri::command]
#[specta::specta]
pub async fn make_symlink(target: String, name: String) -> AppResult<FileEntry> {
    let target_path = validate_path(&target)?;
    check_name(&name)?;
    let dir = target_path
        .parent()
        .ok_or_else(|| AppError::InvalidPath { path: target.clone(), reason: "no enclosing folder".into() })?
        .to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let link = names::untitled(&dir, &name, false);
        std::os::unix::fs::symlink(&target_path, &link).map_err(|e| AppError::from_io(&e, &link))?;
        build_entry_for(&link).ok_or_else(|| AppError::NotFound { path: link.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| AppError::Io { path: Some(target), message: e.to_string() })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_of_a_file_and_cancel() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("abc.txt");
        fs::write(&file, b"abc").unwrap();
        assert_eq!(
            sha256_hex(&file, &AtomicBool::new(false)).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(matches!(sha256_hex(&file, &AtomicBool::new(true)), Err(AppError::Cancelled)));
        assert!(sha256_hex(tmp.path(), &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn a_cancel_before_register_still_cancels() {
        let jobs = JobManager::default();
        jobs.cancel("early".into());
        let (cancel, _) = jobs.register("early").unwrap();
        assert!(cancel.load(Ordering::Relaxed));
        let (other, _) = jobs.register("other").unwrap();
        assert!(!other.load(Ordering::Relaxed));
    }

    #[test]
    fn make_symlink_points_at_the_target_and_picks_a_free_name() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("photo.jpg");
        fs::write(&target, b"x").unwrap();
        let target_str = target.to_string_lossy().into_owned();
        let make = || {
            tauri::async_runtime::block_on(make_symlink(target_str.clone(), "photo.jpg alias".into()))
                .unwrap()
        };
        let first = make();
        let second = make();
        assert!(first.path.ends_with("/photo.jpg alias"));
        assert!(second.path.ends_with("/photo.jpg alias 2"));
        assert_eq!(fs::read_link(&first.path).unwrap(), target);
        assert!(
            tauri::async_runtime::block_on(make_symlink(target_str.clone(), "../escape".into())).is_err()
        );
    }
}
