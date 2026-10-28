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

/// Most suggestions `complete_path` returns.
const COMPLETIONS: usize = 100;

/// Folder names in `dir` starting with `prefix` (case-insensitive), for Tab in
/// Go to Folder. Hidden folders only when the prefix starts with a dot.
#[tauri::command]
#[specta::specta]
pub async fn complete_path(dir: String, prefix: String) -> AppResult<Vec<String>> {
    let d = validate_path(&dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        let rd = fs::read_dir(&d).map_err(|e| AppError::from_io(&e, &d))?;
        Ok(completions(rd.filter_map(Result::ok).map(|e| e.path()), &prefix))
    })
    .await
    .map_err(|e| AppError::Io { path: Some(dir), message: e.to_string() })?
}

fn completions(paths: impl Iterator<Item = std::path::PathBuf>, prefix: &str) -> Vec<String> {
    let want = prefix.to_lowercase();
    let mut names: Vec<String> = paths
        .filter(|p| p.is_dir())
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .filter(|n| (!n.starts_with('.') || want.starts_with('.')) && n.to_lowercase().starts_with(&want))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    names.truncate(COMPLETIONS);
    names
}

/// Starts (or ref-counts) live updates for `path`; changes arrive as `DirChanged` events.
#[tauri::command]
#[specta::specta]
pub fn watch_dir(window: tauri::Window, watcher: State<'_, DirWatcher>, path: String) -> AppResult<()> {
    watcher.watch(&validate_path(&path)?, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn unwatch_dir(window: tauri::Window, watcher: State<'_, DirWatcher>, path: String) -> AppResult<()> {
    watcher.unwatch(&validate_path(&path)?, window.label());
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn completes_folder_names() {
        let tmp = tempfile::tempdir().unwrap();
        for d in ["Documents", "docs", ".dotfiles", "Desktop"] {
            std::fs::create_dir(tmp.path().join(d)).unwrap();
        }
        std::fs::write(tmp.path().join("doc.txt"), "").unwrap();
        let list = |prefix: &str| {
            super::completions(std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().path()), prefix)
        };
        assert_eq!(list("do"), vec!["docs", "Documents"]);
        assert_eq!(list(""), vec!["Desktop", "docs", "Documents"]);
        assert_eq!(list("."), vec![".dotfiles"]);
    }
}
