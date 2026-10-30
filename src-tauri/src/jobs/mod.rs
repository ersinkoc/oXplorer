//! Long-running file operations: one thread per job, progress over a Channel,
//! cooperative cancellation, and conflict prompts answered by the frontend.

pub(crate) mod archive;
pub mod convert;
pub mod dupes;
mod fsops;
mod names;
mod rename;
mod run;
mod split;
pub mod sync;
mod types;
pub mod verify;

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
    paused: Arc<AtomicBool>,
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
    /// Cancel flag, conflict answer slot and pause flag of a new job.
    fn register(&self, id: &str) -> AppResult<(Arc<AtomicBool>, ConflictSlot, Arc<AtomicBool>)> {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        if jobs.contains_key(id) {
            return Err(AppError::AlreadyExists { path: format!("job {id}") });
        }
        let early = self.early_cancels.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
        let cancel = Arc::new(AtomicBool::new(early));
        let conflict = Arc::new(Mutex::new(None));
        let paused = Arc::new(AtomicBool::new(false));
        jobs.insert(
            id.to_owned(),
            Handle {
                cancel: Arc::clone(&cancel),
                conflict: Arc::clone(&conflict),
                paused: Arc::clone(&paused),
            },
        );
        Ok((cancel, conflict, paused))
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
    paused: Arc<AtomicBool>,
    last_progress: Option<Instant>,
}

impl run::Reporter for ChannelReporter {
    fn planned(&mut self, total_bytes: u64, total_items: u32) {
        let _ = self.channel.send(JobEvent::Planned { total_bytes, total_items });
    }

    fn progress(&mut self, done_bytes: u64, done_items: u32, current: &Path) {
        // Paused: hold the job here (between chunks), still honoring cancel.
        while self.paused.load(Ordering::Relaxed) && !self.cancelled() {
            std::thread::sleep(Duration::from_millis(100));
        }
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
    let (cancel, conflict, paused) = jobs.register(&id)?;
    // Only local copies pause: archive and server streams would time out while held open.
    let pausable = matches!(
        spec,
        JobSpec::Copy { .. }
            | JobSpec::Move { .. }
            | JobSpec::Duplicate { .. }
            | JobSpec::Sync { .. }
            | JobSpec::Split { .. }
            | JobSpec::Join { .. }
    );
    let paused = if pausable { paused } else { Arc::new(AtomicBool::new(false)) };
    let manager = Arc::clone(&jobs);
    std::thread::Builder::new()
        .name(format!("job-{id}"))
        .spawn(move || {
            let mut reporter =
                ChannelReporter { channel: on_event.clone(), cancel, conflict, paused, last_progress: None };
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

/// Pauses or resumes a copy / move (it stops between chunks; cancel still works).
#[tauri::command]
#[specta::specta]
pub fn pause_job(jobs: State<'_, Arc<JobManager>>, id: String, paused: bool) {
    if let Some(h) = jobs.jobs.lock().unwrap_or_else(PoisonError::into_inner).get(&id) {
        h.paused.store(paused, Ordering::Relaxed);
    }
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

/// Find Duplicates in `path`; groups stream through `on_event`. Cancel with `cancel_job(id)`.
#[tauri::command]
#[specta::specta]
pub async fn find_duplicates(
    jobs: State<'_, Arc<JobManager>>,
    id: String,
    path: String,
    on_event: Channel<dupes::DupEvent>,
) -> AppResult<()> {
    let root = validate_path(&path)?;
    let (cancel, _, _) = jobs.register(&id)?;
    let manager = Arc::clone(&jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let stop = || cancel.load(Ordering::Relaxed);
        dupes::find(&root, &stop, &mut |ev| !stop() && on_event.send(ev).is_ok());
        manager.unregister(&id);
    });
    Ok(())
}

/// How many items are in the Trash (Empty Trash asks before erasing them).
#[tauri::command]
#[specta::specta]
pub async fn trash_count() -> AppResult<u32> {
    tauri::async_runtime::spawn_blocking(|| {
        let n = run::trash_entries(&run::trash_dir()?)?.len();
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Verify Checksums: checks the files the list at `path` names; results stream
/// through `on_event`. Cancel with `cancel_job(id)`.
#[tauri::command]
#[specta::specta]
pub async fn verify_checksums(
    jobs: State<'_, Arc<JobManager>>,
    id: String,
    path: String,
    on_event: Channel<verify::VerifyEvent>,
) -> AppResult<()> {
    let list = validate_path(&path)?;
    let (cancel, _, _) = jobs.register(&id)?;
    let manager = Arc::clone(&jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let stop = || cancel.load(Ordering::Relaxed);
        let out = verify::verify(&list, &stop, &mut |ev| on_event.send(ev).is_ok());
        manager.unregister(&id);
        out.map_err(|e| AppError::from_io(&e, &list))
    })
    .await
    .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

/// Synchronize Folders: differences between `left` and `right` stream through
/// `on_event`. Cancel with `cancel_job(id)`.
#[tauri::command]
#[specta::specta]
pub async fn compare_folders(
    jobs: State<'_, Arc<JobManager>>,
    id: String,
    left: String,
    right: String,
    by_content: bool,
    on_event: Channel<sync::SyncEvent>,
) -> AppResult<()> {
    let left = validate_path(&left)?;
    let right = validate_path(&right)?;
    let (cancel, _, _) = jobs.register(&id)?;
    let manager = Arc::clone(&jobs);
    tauri::async_runtime::spawn_blocking(move || {
        let stop = || cancel.load(Ordering::Relaxed);
        sync::compare(&left, &right, by_content, &stop, &mut |ev| !stop() && on_event.send(ev).is_ok());
        manager.unregister(&id);
    });
    Ok(())
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
    let (cancel, _, _) = jobs.register(&id)?;
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

/// Get Info → Permissions: sets the rwx bits (the 9 low bits; special bits are kept).
#[tauri::command]
#[specta::specta]
pub async fn set_permissions(path: String, mode: u32) -> AppResult<FileEntry> {
    use std::os::unix::fs::PermissionsExt as _;
    let p = validate_path(&path)?;
    if mode > 0o777 {
        return Err(AppError::InvalidPath { path, reason: format!("bad permissions {mode:o}") });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::symlink_metadata(&p).map_err(|e| AppError::from_io(&e, &p))?;
        if meta.file_type().is_symlink() {
            return Err(AppError::InvalidPath {
                path: p.to_string_lossy().into_owned(),
                reason: "a symbolic link has no permissions of its own".into(),
            });
        }
        let next = (meta.permissions().mode() & !0o777) | mode;
        fs::set_permissions(&p, fs::Permissions::from_mode(next)).map_err(|e| AppError::from_io(&e, &p))?;
        build_entry_for(&p).ok_or_else(|| AppError::NotFound { path: p.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Extract: whether a zip is encrypted, so the password can be asked for first.
#[tauri::command]
#[specta::specta]
pub async fn archive_encrypted(path: String) -> AppResult<bool> {
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        archive::zip_encrypted(&p).map_err(|e| AppError::from_io(&e, &p))
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Unlocks an encrypted zip that's browsed like a folder: checks the password and
/// keeps it in memory for this session, so its members can be read.
#[tauri::command]
#[specta::specta]
pub async fn archive_unlock(path: String, password: Password) -> AppResult<()> {
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        archive::unlock(&p, &password.0).map_err(|e| AppError::from_io(&e, &p))
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Get Info → Locked: whether the item has the user immutable flag (Finder's "Locked").
#[tauri::command]
#[specta::specta]
pub async fn is_locked(path: String) -> AppResult<bool> {
    use std::os::macos::fs::MetadataExt as _;
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::symlink_metadata(&p).map_err(|e| AppError::from_io(&e, &p))?;
        Ok(meta.st_flags() & libc::UF_IMMUTABLE != 0)
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Locks or unlocks an item (the user immutable flag, like Finder). Returns the new state.
#[tauri::command]
#[specta::specta]
pub async fn set_locked(path: String, locked: bool) -> AppResult<bool> {
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || set_locked_flag(&p, locked))
        .await
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

fn set_locked_flag(p: &Path, locked: bool) -> AppResult<bool> {
    use std::os::macos::fs::MetadataExt as _;
    use std::os::unix::ffi::OsStrExt as _;
    let meta = fs::symlink_metadata(p).map_err(|e| AppError::from_io(&e, p))?;
    if meta.file_type().is_symlink() {
        return Err(AppError::InvalidPath {
            path: p.to_string_lossy().into_owned(),
            reason: "a symbolic link can’t be locked".into(),
        });
    }
    let flags =
        if locked { meta.st_flags() | libc::UF_IMMUTABLE } else { meta.st_flags() & !libc::UF_IMMUTABLE };
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| AppError::InvalidPath {
        path: p.to_string_lossy().into_owned(),
        reason: "contains a NUL byte".into(),
    })?;
    // SAFETY: `c` is a valid NUL-terminated path that outlives the call.
    if unsafe { libc::chflags(c.as_ptr(), flags) } != 0 {
        return Err(AppError::from_io(&std::io::Error::last_os_error(), p));
    }
    Ok(locked)
}

/// SHA-256 of a file as lowercase hex (Get Info). Cancel with `cancel_job(id)`.
#[tauri::command]
#[specta::specta]
pub async fn checksum(jobs: State<'_, Arc<JobManager>>, id: String, path: String) -> AppResult<String> {
    let p = validate_path(&path)?;
    let (cancel, _, _) = jobs.register(&id)?;
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

/// Convert Image: a copy of `path` in `format`, its longer side at most `max_size` pixels.
#[tauri::command]
#[specta::specta]
pub async fn convert_image(
    path: String,
    format: convert::ImageFormat,
    max_size: Option<u32>,
) -> AppResult<FileEntry> {
    let src = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let out = convert::convert(&src, format, max_size)?;
        build_entry_for(&out).ok_or_else(|| AppError::NotFound { path: out.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locking_blocks_changes_until_unlocked() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("keep.txt");
        fs::write(&file, b"v1").unwrap();
        let path = file.to_string_lossy().into_owned();
        assert!(tauri::async_runtime::block_on(set_locked(path.clone(), true)).unwrap());
        assert!(tauri::async_runtime::block_on(is_locked(path.clone())).unwrap());
        assert!(fs::write(&file, b"v2").is_err());
        assert!(!tauri::async_runtime::block_on(set_locked(path.clone(), false)).unwrap());
        assert!(!tauri::async_runtime::block_on(is_locked(path)).unwrap());
        fs::write(&file, b"v2").unwrap();
    }

    #[test]
    fn set_permissions_changes_rwx_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("run.sh");
        fs::write(&file, b"").unwrap();
        let path = file.to_string_lossy().into_owned();
        let entry = tauri::async_runtime::block_on(set_permissions(path.clone(), 0o750)).unwrap();
        assert_eq!(entry.mode & 0o777, 0o750);
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o750);
        assert!(tauri::async_runtime::block_on(set_permissions(path, 0o4755)).is_err());
    }

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
    fn a_paused_job_waits_in_progress_until_resumed_or_cancelled() {
        use run::Reporter as _;
        let jobs = JobManager::default();
        let (cancel, conflict, paused) = jobs.register("p").unwrap();
        paused.store(true, Ordering::Relaxed);
        let mut reporter = ChannelReporter {
            channel: Channel::new(|_| Ok(())),
            cancel: Arc::clone(&cancel),
            conflict,
            paused: Arc::clone(&paused),
            last_progress: None,
        };
        let worker = std::thread::spawn(move || reporter.progress(1, 1, Path::new("/x")));
        std::thread::sleep(Duration::from_millis(300));
        assert!(!worker.is_finished(), "paused job kept going");
        paused.store(false, Ordering::Relaxed);
        worker.join().unwrap();

        // Cancel also releases a paused job.
        let (cancel, conflict, paused) = jobs.register("q").unwrap();
        paused.store(true, Ordering::Relaxed);
        let mut reporter = ChannelReporter {
            channel: Channel::new(|_| Ok(())),
            cancel: Arc::clone(&cancel),
            conflict,
            paused,
            last_progress: None,
        };
        let worker = std::thread::spawn(move || reporter.progress(1, 1, Path::new("/x")));
        jobs.cancel("q".into());
        worker.join().unwrap();
    }

    #[test]
    fn a_cancel_before_register_still_cancels() {
        let jobs = JobManager::default();
        jobs.cancel("early".into());
        let (cancel, _, _) = jobs.register("early").unwrap();
        assert!(cancel.load(Ordering::Relaxed));
        let (other, _, _) = jobs.register("other").unwrap();
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
