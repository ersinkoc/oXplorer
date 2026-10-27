use std::ffi::{CStr, CString};
use std::fs;
use std::io;
use std::mem::MaybeUninit;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt as _;

use crate::error::{AppError, AppResult};
use crate::model::{FullDiskAccess, SpaceInfo, StandardLocation, VolumeInfo};
use crate::security::validate_path;

#[tauri::command]
#[specta::specta]
pub fn home_dir() -> AppResult<String> {
    dirs::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Io { path: None, message: "home directory unknown".into() })
}

/// Folder passed on the command line (`oxplorer ~/Projects`), if it exists.
#[tauri::command]
#[specta::specta]
pub fn launch_dir() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    let path = validate_path(&arg).ok()?;
    path.is_dir().then(|| path.to_string_lossy().into_owned())
}

/// Dev-only: a scratch folder for the in-app integration self-test
/// (`OX_SELFTEST_DIR=/tmp/x pnpm tauri dev`). Always `None` in release builds.
#[tauri::command]
#[specta::specta]
pub fn self_test_dir() -> Option<String> {
    if cfg!(debug_assertions) { std::env::var("OX_SELFTEST_DIR").ok() } else { None }
}

/// Default sidebar favorites, only those that exist on this machine.
#[tauri::command]
#[specta::specta]
pub fn standard_locations() -> Vec<StandardLocation> {
    let candidates: [(&str, &str, Option<PathBuf>); 6] = [
        ("home", "Home", dirs::home_dir()),
        ("desktop", "Desktop", dirs::desktop_dir()),
        ("documents", "Documents", dirs::document_dir()),
        ("downloads", "Downloads", dirs::download_dir()),
        ("applications", "Applications", Some(PathBuf::from("/Applications"))),
        ("pictures", "Pictures", dirs::picture_dir()),
    ];
    candidates
        .into_iter()
        .filter_map(|(id, name, path)| {
            let path = path?;
            path.exists().then(|| StandardLocation {
                id: id.into(),
                name: name.into(),
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

/// Mounted, user-visible volumes (what Finder lists under "Locations").
#[tauri::command]
#[specta::specta]
pub async fn list_volumes() -> AppResult<Vec<VolumeInfo>> {
    tauri::async_runtime::spawn_blocking(collect_volumes)
        .await
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

fn collect_volumes() -> AppResult<Vec<VolumeInfo>> {
    let root = Path::new("/Volumes");
    let read = fs::read_dir(root).map_err(|e| AppError::from_io(&e, root))?;
    let mut volumes: Vec<VolumeInfo> = read
        .filter_map(Result::ok)
        .filter_map(|item| {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                return None;
            }
            let link = item.path();
            // `/Volumes/Macintosh HD` is a symlink to `/` on modern macOS.
            let mount = fs::canonicalize(&link).ok()?;
            let is_root = mount == Path::new("/");
            let fs_info = statfs(&mount).ok()?;
            if fs_info.dont_browse && !is_root {
                return None;
            }
            Some(VolumeInfo {
                name,
                mount_point: if is_root { "/".into() } else { link.to_string_lossy().into_owned() },
                total_bytes: fs_info.total,
                available_bytes: fs_info.available,
                file_system: fs_info.fs_type,
                is_root,
                is_local: fs_info.local,
                is_read_only: fs_info.read_only,
            })
        })
        .collect();
    volumes.sort_by(|a, b| b.is_root.cmp(&a.is_root).then_with(|| a.name.cmp(&b.name)));
    Ok(volumes)
}

/// Unmounts and ejects a removable/network volume (not the boot volume).
#[tauri::command]
#[specta::specta]
pub async fn eject_volume(mount_point: String) -> AppResult<()> {
    let path = validate_path(&mount_point)?;
    if !path.starts_with("/Volumes/") || path.components().count() != 3 {
        return Err(AppError::InvalidPath { path: mount_point, reason: "not an ejectable volume".into() });
    }
    let output = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/usr/sbin/diskutil").arg("eject").arg(&path).output()
    })
    .await
    .map_err(|e| AppError::Io { path: Some(mount_point.clone()), message: e.to_string() })?
    .map_err(|e| AppError::Io { path: Some(mount_point.clone()), message: e.to_string() })?;
    if output.status.success() {
        Ok(())
    } else {
        // diskutil explains why (e.g. "Volume in use by …"); pass that through.
        let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let message = if message.is_empty() {
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        } else {
            message
        };
        Err(AppError::Io { path: Some(mount_point), message })
    }
}

#[tauri::command]
#[specta::specta]
pub async fn space_for(path: String) -> AppResult<SpaceInfo> {
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let s = statfs(&p).map_err(|e| AppError::from_io(&e, &p))?;
        Ok(SpaceInfo { total_bytes: s.total, available_bytes: s.available })
    })
    .await
    .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

/// Probes locations that TCC only exposes with Full Disk Access. Not every probe
/// exists on every machine, so the first one that does decides. In `tauri dev`
/// the answer reflects the terminal's grant, not OXplorer's.
#[tauri::command]
#[specta::specta]
pub fn check_full_disk_access() -> FullDiskAccess {
    let Some(home) = dirs::home_dir() else { return FullDiskAccess::Unknown };
    let probes = [
        "Library/Application Support/com.apple.TCC/TCC.db",
        "Library/Safari",
        "Library/Mail",
        "Library/Messages",
        "Library/Containers/com.apple.stocks",
    ];
    for probe in probes {
        let path = home.join(probe);
        let res = if probe.ends_with(".db") {
            fs::File::open(&path).map(drop)
        } else {
            fs::read_dir(&path).map(drop)
        };
        match res {
            Ok(()) => return FullDiskAccess::Granted,
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return FullDiskAccess::Denied,
            Err(_) => {}
        }
    }
    FullDiskAccess::Unknown
}

#[tauri::command]
#[specta::specta]
pub fn open_path(app: AppHandle, path: String) -> AppResult<()> {
    let p = validate_path(&path)?;
    app.opener()
        .open_path(p.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })
}

#[tauri::command]
#[specta::specta]
pub fn reveal_in_finder(app: AppHandle, path: String) -> AppResult<()> {
    let p = validate_path(&path)?;
    app.opener().reveal_item_in_dir(&p).map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })
}

#[tauri::command]
#[specta::specta]
pub fn open_full_disk_access_settings(app: AppHandle) -> AppResult<()> {
    app.opener()
        .open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", None::<&str>)
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })
}

struct FsStat {
    total: u64,
    available: u64,
    fs_type: String,
    local: bool,
    read_only: bool,
    dont_browse: bool,
}

fn statfs(path: &Path) -> io::Result<FsStat> {
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut buf = MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: c_path is a valid NUL-terminated string and buf is a properly sized out-pointer.
    let rc = unsafe { libc::statfs(c_path.as_ptr(), buf.as_mut_ptr()) };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statfs returned 0, so the struct is fully initialised.
    let s = unsafe { buf.assume_init() };
    let bsize = u64::from(s.f_bsize);
    // SAFETY: f_fstypename is a NUL-terminated C char array filled in by the kernel.
    let fs_type = unsafe { CStr::from_ptr(s.f_fstypename.as_ptr()) }.to_string_lossy().into_owned();
    let flags = s.f_flags;
    Ok(FsStat {
        total: s.f_blocks * bsize,
        available: s.f_bavail * bsize,
        fs_type,
        local: flags & libc::MNT_LOCAL as u32 != 0,
        read_only: flags & libc::MNT_RDONLY as u32 != 0,
        dont_browse: flags & libc::MNT_DONTBROWSE as u32 != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statfs_root() {
        let s = statfs(Path::new("/")).unwrap();
        assert!(s.total > 0 && s.available <= s.total);
        assert!(!s.fs_type.is_empty());
    }

    #[test]
    fn volumes_include_root() {
        let v = collect_volumes().unwrap();
        assert!(v.first().is_some_and(|v| v.is_root), "root volume first: {v:?}");
    }
}

/// Paths handed to the app from outside, waiting for the frontend to open them.
#[derive(Default)]
pub struct OpenRequests(std::sync::Mutex<Vec<String>>);

/// Queues existing paths and tells the frontend to fetch them. Queuing (instead of
/// sending them in the event) covers requests that arrive before the UI listens.
pub fn request_open(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) {
    use tauri::Manager as _;
    use tauri_specta::Event as _;
    let valid: Vec<String> = paths
        .into_iter()
        .filter_map(|p| validate_path(&p.to_string_lossy()).ok())
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if valid.is_empty() {
        return;
    }
    let count = u32::try_from(valid.len()).unwrap_or(u32::MAX);
    if let Some(queue) = app.try_state::<OpenRequests>()
        && let Ok(mut q) = queue.0.lock()
    {
        q.extend(valid);
    }
    let _ = crate::model::OpenRequested { count }.emit(app);
}

#[tauri::command]
#[specta::specta]
pub fn take_open_requests(queue: tauri::State<'_, OpenRequests>) -> Vec<String> {
    queue.0.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
}

/// Arguments of a second `oxplorer <path>` launch, resolved against its cwd.
pub fn paths_from_args(args: &[String], cwd: &str) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = Path::new(a);
            if p.is_absolute() { p.to_path_buf() } else { Path::new(cwd).join(p) }
        })
        .collect()
}
