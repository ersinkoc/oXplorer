//! Low-level filesystem operations used by jobs. All of them are blocking.

use std::ffi::{CString, c_char, c_int, c_void};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use objc2::rc::autoreleasepool;
use objc2_foundation::{NSFileManager, NSString, NSURL};

use super::types::SizeInfo;

fn c_path(p: &Path) -> io::Result<CString> {
    CString::new(p.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

/// Context handed to the copyfile status callback.
struct Progress<'a> {
    /// Receives bytes copied so far for the current file; returning `false` aborts.
    on_bytes: &'a mut dyn FnMut(u64) -> bool,
}

extern "C" fn copy_status(
    what: c_int,
    stage: c_int,
    state: libc::copyfile_state_t,
    _src: *const c_char,
    _dst: *const c_char,
    ctx: *mut c_void,
) -> c_int {
    if what != libc::COPYFILE_COPY_DATA || stage != libc::COPYFILE_PROGRESS {
        return libc::COPYFILE_CONTINUE;
    }
    let mut copied: libc::off_t = 0;
    // SAFETY: `state` is the live state copyfile passed us; COPIED writes an off_t.
    unsafe {
        libc::copyfile_state_get(state, libc::COPYFILE_STATE_COPIED as u32, (&raw mut copied).cast());
    }
    // SAFETY: `ctx` is the `Progress` set on the state below, alive for the whole copyfile call.
    let progress = unsafe { &mut *ctx.cast::<Progress<'_>>() };
    if (progress.on_bytes)(u64::try_from(copied).unwrap_or(0)) {
        libc::COPYFILE_CONTINUE
    } else {
        libc::COPYFILE_QUIT
    }
}

/// Copies one regular file with data, metadata, xattrs (Finder tags) and ACLs.
/// On APFS within one volume this is an instant clone. `on_bytes` reports
/// progress and can cancel; a cancelled or failed copy leaves no partial file.
pub fn copy_file(src: &Path, dst: &Path, on_bytes: &mut dyn FnMut(u64) -> bool) -> io::Result<()> {
    let (from, to) = (c_path(src)?, c_path(dst)?);
    let mut progress = Progress { on_bytes };
    // SAFETY: plain allocation; freed below on every path.
    let state = unsafe { libc::copyfile_state_alloc() };
    if state.is_null() {
        return Err(io::Error::last_os_error());
    }
    let callback: libc::copyfile_callback_t = Some(copy_status);
    // SAFETY: the callback and its context outlive the copyfile call, which is
    // the only user of `state`; flags are documented copyfile(3) flags.
    let rc = unsafe {
        libc::copyfile_state_set(state, libc::COPYFILE_STATE_STATUS_CB as u32, (&raw const callback).cast());
        libc::copyfile_state_set(
            state,
            libc::COPYFILE_STATE_STATUS_CTX as u32,
            (&raw mut progress).cast::<c_void>(),
        );
        let rc = libc::copyfile(
            from.as_ptr(),
            to.as_ptr(),
            state,
            libc::COPYFILE_METADATA
                | libc::COPYFILE_DATA
                | libc::COPYFILE_CLONE
                | libc::COPYFILE_EXCL
                | libc::COPYFILE_NOFOLLOW_SRC,
        );
        libc::copyfile_state_free(state);
        rc
    };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    // EEXIST means the destination was someone else's file, which must stay.
    if err.kind() != io::ErrorKind::AlreadyExists {
        let _ = fs::remove_file(dst);
    }
    Err(err)
}

/// Copies directory metadata (mode, times, xattrs) after its children were copied.
pub fn copy_dir_metadata(src: &Path, dst: &Path) -> io::Result<()> {
    let (from, to) = (c_path(src)?, c_path(dst)?);
    // SAFETY: valid C strings; a null state is allowed.
    let rc =
        unsafe { libc::copyfile(from.as_ptr(), to.as_ptr(), std::ptr::null_mut(), libc::COPYFILE_METADATA) };
    if rc == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// Modified and created times in epoch ms (created may be unknown).
pub fn dates(path: &Path) -> io::Result<(i64, Option<i64>)> {
    let meta = fs::metadata(path)?;
    let ms = |t: std::time::SystemTime| {
        t.duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    };
    Ok((meta.modified().map(ms)?, meta.created().ok().map(ms)))
}

/// Sets the modified and/or created time (epoch ms) of a file or folder.
pub fn set_dates(path: &Path, modified_ms: Option<i64>, created_ms: Option<i64>) -> io::Result<()> {
    use std::os::darwin::fs::FileTimesExt as _;
    let at = |ms: i64| {
        let ms = u64::try_from(ms)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "dates before 1970"))?;
        Ok::<_, io::Error>(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms))
    };
    let mut times = fs::FileTimes::new();
    if let Some(ms) = modified_ms {
        times = times.set_modified(at(ms)?);
    }
    if let Some(ms) = created_ms {
        times = times.set_created(at(ms)?);
    }
    fs::File::open(path)?.set_times(times)
}

pub fn same_device(a: &Path, b: &Path) -> bool {
    match (fs::symlink_metadata(a), fs::metadata(b)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev(),
        _ => false,
    }
}

/// Moves `path` to the Trash and returns where it ended up (needed to put it back).
pub fn trash(path: &Path) -> io::Result<PathBuf> {
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let mut resulting = None;
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
            .map_err(|e| {
                let code = e.code();
                // Cocoa file errors: 4 = no such file, 513 = no permission.
                let kind = match code {
                    4 => io::ErrorKind::NotFound,
                    513 => io::ErrorKind::PermissionDenied,
                    _ => io::ErrorKind::Other,
                };
                io::Error::new(kind, e.localizedDescription().to_string())
            })?;
        resulting
            .and_then(|u| u.path())
            .map(|p| PathBuf::from(p.to_string()))
            .ok_or_else(|| io::Error::other("Trash did not report a location"))
    })
}

/// Removes a file, symlink or whole directory tree without following symlinks.
pub fn remove(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }
}

/// Recursive size; hard links are counted once. `tick` is called periodically
/// with the running total and can cancel by returning `false`.
pub fn measure(paths: &[PathBuf], tick: &mut dyn FnMut(&SizeInfo) -> bool) -> Option<SizeInfo> {
    let mut size = SizeInfo::default();
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<PathBuf> = paths.to_vec();
    let mut n = 0u32;
    while let Some(p) = stack.pop() {
        let Ok(meta) = fs::symlink_metadata(&p) else { continue };
        if meta.is_dir() {
            size.folders += 1;
            if let Ok(read) = fs::read_dir(&p) {
                stack.extend(read.flatten().map(|e| e.path()));
            }
        } else {
            if meta.nlink() > 1 && !seen.insert((meta.dev(), meta.ino())) {
                continue;
            }
            size.files += 1;
            size.bytes += meta.len();
            size.allocated += meta.blocks() * 512;
        }
        n += 1;
        if n.is_multiple_of(2048) && !tick(&size) {
            return None;
        }
    }
    Some(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_data_and_tags_and_reports_progress() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("big.bin");
        fs::write(&src, vec![7u8; 3 * 1024 * 1024]).unwrap();
        xattr::set(&src, "com.example.test", b"v").unwrap();

        let dst = tmp.path().join("copy.bin");
        let mut last = 0;
        copy_file(&src, &dst, &mut |b| {
            last = b;
            true
        })
        .unwrap();
        assert_eq!(fs::read(&dst).unwrap().len(), 3 * 1024 * 1024);
        assert_eq!(xattr::get(&dst, "com.example.test").unwrap().as_deref(), Some(&b"v"[..]));
        // A clone reports no progress; a data copy reports up to the full size.
        assert!(last == 0 || last == 3 * 1024 * 1024, "{last}");

        // Never overwrites.
        let err = copy_file(&src, &dst, &mut |_| true).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert!(dst.exists(), "existing destination must survive EEXIST");
    }

    #[test]
    fn trash_reports_location_and_measure_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("folder");
        fs::create_dir(&d).unwrap();
        fs::write(d.join("a"), "12345").unwrap();
        fs::hard_link(d.join("a"), d.join("a-link")).unwrap();
        fs::write(d.join("b"), "123").unwrap();

        let size = measure(std::slice::from_ref(&d), &mut |_| true).unwrap();
        assert_eq!((size.files, size.folders, size.bytes), (2, 1, 8), "hard link counted once");

        let victim = tmp.path().join("victim.txt");
        fs::write(&victim, "x").unwrap();
        match trash(&victim) {
            Ok(location) => {
                assert!(!victim.exists());
                assert!(location.exists(), "{location:?}");
                fs::rename(&location, &victim).unwrap();
            }
            // Some sandboxes/volumes have no Trash; that's an environment limit, not a bug.
            Err(e) => eprintln!("trash unavailable here: {e}"),
        }
    }
}
