mod lister;
mod watcher;

pub use lister::is_package_path;
pub use watcher::DirWatcher;

use std::fs;

use tauri::State;
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};
use crate::model::{DirEvent, FileEntry};
use crate::security::validate_path;

/// Streams the directory listing through `on_event`; resolves once the listing
/// is complete (or rejects with the reason it couldn't be read).
#[tauri::command]
#[specta::specta]
pub async fn open_dir(path: String, on_event: Channel<DirEvent>) -> AppResult<()> {
    let dir = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || lister::list_dir(&dir, |ev| on_event.send(ev).is_ok()))
        .await
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

/// Stats one path (without following symlinks) into a full entry, tags included.
pub fn build_entry_for(path: &std::path::Path) -> Option<FileEntry> {
    let meta = fs::symlink_metadata(path).ok()?;
    let name = path.file_name().map_or_else(|| "/".to_owned(), |n| n.to_string_lossy().into_owned());
    Some(lister::build_entry(name, path, &meta, true))
}

/// Metadata for a single path (follows nothing — the entry itself).
#[tauri::command]
#[specta::specta]
pub async fn stat_path(path: String) -> AppResult<FileEntry> {
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::symlink_metadata(&p).map_err(|e| AppError::from_io(&e, &p))?;
        let name = p.file_name().map_or_else(|| "/".to_owned(), |n| n.to_string_lossy().into_owned());
        Ok(lister::build_entry(name, &p, &meta, true))
    })
    .await
    .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

/// Starts (or ref-counts) live updates for `path`; changes arrive as `DirChanged` events.
#[tauri::command]
#[specta::specta]
pub fn watch_dir(watcher: State<'_, DirWatcher>, path: String) -> AppResult<()> {
    watcher.watch(&validate_path(&path)?)
}

#[tauri::command]
#[specta::specta]
pub fn unwatch_dir(watcher: State<'_, DirWatcher>, path: String) -> AppResult<()> {
    watcher.unwatch(&validate_path(&path)?);
    Ok(())
}
