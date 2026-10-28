//! Commands that bridge to other apps: pasteboard, Open With, drag-out previews.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager as _};

use crate::error::{AppError, AppResult};
use crate::mac::{apps, images, pasteboard, quicklook};
use crate::security::validate_path;

fn validate_all(paths: &[String]) -> AppResult<Vec<PathBuf>> {
    paths.iter().map(|p| validate_path(p)).collect()
}

/// Puts files on the general pasteboard so Finder (and other apps) can paste them.
#[tauri::command]
#[specta::specta]
pub fn pasteboard_write_files(paths: Vec<String>) -> AppResult<()> {
    let paths = validate_all(&paths)?;
    if pasteboard::write_files(&paths) {
        Ok(())
    } else {
        Err(AppError::Io { path: None, message: "couldn’t write to the clipboard".into() })
    }
}

/// Files on the general pasteboard that still exist.
#[tauri::command]
#[specta::specta]
pub fn pasteboard_read_files() -> Vec<String> {
    pasteboard::read_files()
        .into_iter()
        .filter(|p| pasteboard::exists_all(std::slice::from_ref(p)))
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
#[specta::specta]
pub async fn apps_for_path(path: String) -> AppResult<Vec<apps::AppInfo>> {
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || apps::apps_for(&p))
        .await
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })
}

#[tauri::command]
#[specta::specta]
pub async fn open_with(app: String, paths: Vec<String>) -> AppResult<()> {
    let app_path = validate_path(&app)?;
    if app_path.extension().is_none_or(|e| e != "app") {
        return Err(AppError::InvalidPath { path: app, reason: "not an application".into() });
    }
    let paths = validate_all(&paths)?;
    let status = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/open").arg("-a").arg(&app_path).arg("--").args(&paths).status()
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    if status.success() {
        Ok(())
    } else {
        Err(AppError::Io { path: None, message: format!("open exited with {status}") })
    }
}

/// Writes the icon of `path` to a cache file for the native drag image and returns its path.
#[tauri::command]
#[specta::specta]
pub async fn drag_preview(app: AppHandle, path: String) -> AppResult<String> {
    let p = validate_path(&path)?;
    let dir = app.path().app_cache_dir().map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    tauri::async_runtime::spawn_blocking(move || {
        let png = images::icon_for_path(&p, 64)
            .ok_or_else(|| AppError::Io { path: Some(path.clone()), message: "no icon".into() })?;
        fs::create_dir_all(&dir).map_err(|e| AppError::from_io(&e, &dir))?;
        let out = dir.join("drag-preview.png");
        fs::write(&out, png).map_err(|e| AppError::from_io(&e, &out))?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Opens the Quick Look panel on `paths` at `index`. With `open: false` it only
/// follows the selection while the panel is already showing.
#[tauri::command]
#[specta::specta]
pub fn quick_look(app: AppHandle, paths: Vec<String>, index: u32, open: bool) -> AppResult<()> {
    let paths = validate_all(&paths)?;
    let index = usize::try_from(index).unwrap_or(0);
    app.run_on_main_thread(move || quicklook::present(&paths, index, open))
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })
}

#[tauri::command]
#[specta::specta]
pub fn quick_look_close(app: AppHandle) -> AppResult<()> {
    app.run_on_main_thread(quicklook::close).map_err(|e| AppError::Io { path: None, message: e.to_string() })
}

#[tauri::command]
#[specta::specta]
pub async fn quick_look_visible(app: AppHandle) -> bool {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    if app
        .run_on_main_thread(move || {
            let _ = tx.send(quicklook::is_visible());
        })
        .is_err()
    {
        return false;
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false)).await.unwrap_or(false)
}

/// The items after a tag edit, and how to put their tags back.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagEditOutcome {
    pub entries: Vec<crate::model::FileEntry>,
    pub undo: crate::jobs::UndoAction,
}

/// Adds and removes Finder tags on each item; returns the updated entries.
#[tauri::command]
#[specta::specta]
pub async fn edit_tags(
    paths: Vec<String>,
    add: Vec<crate::model::FinderTag>,
    remove: Vec<String>,
) -> AppResult<TagEditOutcome> {
    let paths = validate_all(&paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        let mut steps = Vec::new();
        for p in &paths {
            let before = crate::mac::tags::read_tags(p);
            crate::mac::tags::edit_tags(p, &add, &remove).map_err(|e| AppError::from_io(&e, p))?;
            steps.push(crate::jobs::UndoStep::Tags { path: p.to_string_lossy().into_owned(), tags: before });
            entries.push(
                crate::dir::build_entry_for(p)
                    .ok_or_else(|| AppError::NotFound { path: p.to_string_lossy().into_owned() })?,
            );
        }
        Ok(TagEditOutcome { entries, undo: crate::jobs::UndoAction { label: "Tags".into(), steps } })
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}
