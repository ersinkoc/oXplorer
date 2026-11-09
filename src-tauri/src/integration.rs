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

/// Writes clipboard content into `dir` as a new file (`Pasted Image.png`,
/// `Pasted Text.txt`, or the next free variant); never replaces anything.
fn save_content(dir: &std::path::Path, content: pasteboard::Content) -> std::io::Result<PathBuf> {
    let (name, bytes) = match content {
        pasteboard::Content::Png(bytes) => ("Pasted Image.png", bytes),
        pasteboard::Content::Text(text) => ("Pasted Text.txt", text.into_bytes()),
    };
    for _ in 0..100 {
        let path = crate::jobs::names::untitled(dir, name, true);
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                let written = std::io::Write::write_all(&mut f, &bytes).and_then(|()| f.sync_all());
                return match written {
                    Ok(()) => Ok(path),
                    Err(e) => {
                        let _ = fs::remove_file(&path);
                        Err(e)
                    }
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(std::io::ErrorKind::AlreadyExists.into())
}

/// Whether the clipboard holds a picture or text ⌘V can save as a file.
#[tauri::command]
#[specta::specta]
pub fn pasteboard_has_content() -> bool {
    pasteboard::has_content()
}

/// Set Desktop Picture: the picture at `path` on every screen.
#[tauri::command]
#[specta::specta]
pub async fn set_desktop_picture(app: AppHandle, path: String) -> AppResult<()> {
    let p = validate_path(&path)?;
    if !p.is_file() {
        return Err(AppError::NotFound { path });
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(apps::set_desktop_picture(&p));
    })
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(Err("no answer".into())))
        .await
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    result.map_err(|message| AppError::Io { path: Some(path), message })
}

/// ⌘V without files on the clipboard: a copied picture or text becomes a new
/// file in `dir`. None when the clipboard holds neither.
#[tauri::command]
#[specta::specta]
pub async fn pasteboard_save(app: AppHandle, dir: String) -> AppResult<Option<crate::model::FileEntry>> {
    let dir_path = validate_path(&dir)?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(pasteboard::read_content());
    })
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(content) = rx.recv().ok().flatten() else { return Ok(None) };
        let path = save_content(&dir_path, content).map_err(|e| AppError::from_io(&e, &dir_path))?;
        Ok(crate::dir::build_entry_for(&path))
    })
    .await
    .map_err(|e| AppError::Io { path: Some(dir), message: e.to_string() })?
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

/// The items after an edit (tags, dates), and how to undo it.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditOutcome {
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
) -> AppResult<EditOutcome> {
    let paths = validate_all(&paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        let mut done: Vec<(&PathBuf, Vec<crate::model::FinderTag>)> = Vec::new();
        let result = paths.iter().try_for_each(|p| {
            let before = crate::mac::tags::read_tags(p);
            crate::mac::tags::edit_tags(p, &add, &remove).map_err(|e| AppError::from_io(&e, p))?;
            done.push((p, before));
            entries.push(
                crate::dir::build_entry_for(p)
                    .ok_or_else(|| AppError::NotFound { path: p.to_string_lossy().into_owned() })?,
            );
            Ok(())
        });
        if let Err(e) = result {
            // All or nothing: a half-done edit would have no undo.
            for (p, before) in done.iter().rev() {
                let _ = crate::mac::tags::write_tags(p, before);
            }
            return Err(e);
        }
        let steps = done
            .into_iter()
            .map(|(p, tags)| crate::jobs::UndoStep::Tags { path: p.to_string_lossy().into_owned(), tags })
            .collect();
        Ok(EditOutcome { entries, undo: crate::jobs::UndoAction { label: "Tags".into(), steps } })
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Change Dates: sets the modified and/or created date (epoch ms) of each item.
#[tauri::command]
#[specta::specta]
pub async fn set_dates(
    paths: Vec<String>,
    modified_ms: Option<f64>,
    created_ms: Option<f64>,
) -> AppResult<EditOutcome> {
    let paths = validate_all(&paths)?;
    // Epoch ms arrive as JS numbers; whole milliseconds are all we keep.
    #[allow(clippy::cast_possible_truncation)]
    let ms = |v: Option<f64>| v.filter(|v| v.is_finite()).map(|v| v.round() as i64);
    let (modified_ms, created_ms) = (ms(modified_ms), ms(created_ms));
    tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::new();
        let mut done: Vec<(&PathBuf, i64, Option<i64>)> = Vec::new();
        let result = paths.iter().try_for_each(|p| {
            let (m, c) = crate::jobs::dates(p).map_err(|e| AppError::from_io(&e, p))?;
            crate::jobs::set_dates(p, modified_ms, created_ms).map_err(|e| AppError::from_io(&e, p))?;
            done.push((p, m, c));
            entries.push(
                crate::dir::build_entry_for(p)
                    .ok_or_else(|| AppError::NotFound { path: p.to_string_lossy().into_owned() })?,
            );
            Ok(())
        });
        if let Err(e) = result {
            // All or nothing: a half-done edit would have no undo.
            for (p, m, c) in done.iter().rev() {
                let _ = crate::jobs::set_dates(p, Some(*m), *c);
            }
            return Err(e);
        }
        let steps = done
            .into_iter()
            .map(|(p, modified_ms, created_ms)| crate::jobs::UndoStep::Dates {
                path: p.to_string_lossy().into_owned(),
                modified_ms,
                created_ms,
            })
            .collect();
        Ok(EditOutcome { entries, undo: crate::jobs::UndoAction { label: "Change Dates".into(), steps } })
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_edit_leaves_every_item_as_it_was() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        fs::write(&a, "x").unwrap();
        let before = crate::jobs::dates(&a).unwrap();
        let tags_before = crate::mac::tags::read_tags(&a);
        let paths =
            vec![a.to_string_lossy().into_owned(), tmp.path().join("gone").to_string_lossy().into_owned()];
        // Control: the one existing item alone changes.
        let one = vec![paths[0].clone()];
        tauri::async_runtime::block_on(set_dates(one, Some(946_684_800_000.0), None)).unwrap();
        assert_eq!(crate::jobs::dates(&a).unwrap().0, 946_684_800_000);
        crate::jobs::set_dates(&a, Some(before.0), before.1).unwrap();
        assert_eq!(crate::jobs::dates(&a).unwrap(), before);

        let dated = tauri::async_runtime::block_on(set_dates(paths.clone(), Some(946_684_800_000.0), None));
        let tag = crate::model::FinderTag { name: "Red".into(), color: 6 };
        let tagged = tauri::async_runtime::block_on(edit_tags(paths.clone(), vec![tag], vec![]));
        assert!(dated.is_err() && tagged.is_err());
        assert_eq!(
            (crate::jobs::dates(&a).unwrap(), crate::mac::tags::read_tags(&a)),
            (before, tags_before),
            "the first item kept its new date or tag with nothing to undo it"
        );

        // Every item fine: all change, one undo step each.
        let b = tmp.path().join("b.txt");
        fs::write(&b, "y").unwrap();
        let both = vec![paths[0].clone(), b.to_string_lossy().into_owned()];
        let out =
            tauri::async_runtime::block_on(set_dates(both.clone(), None, Some(915_148_800_000.0))).unwrap();
        assert_eq!(out.undo.steps.len(), 2);
        assert_eq!(crate::jobs::dates(&b).unwrap().1, Some(915_148_800_000));
        // The first item failing: nothing changes.
        let first_gone = vec![tmp.path().join("gone").to_string_lossy().into_owned(), both[1].clone()];
        let tag = crate::model::FinderTag { name: "Blue".into(), color: 4 };
        assert!(tauri::async_runtime::block_on(edit_tags(first_gone, vec![tag], vec![])).is_err());
        assert!(crate::mac::tags::read_tags(&b).is_empty());
    }

    #[test]
    fn pasted_content_gets_a_free_name() {
        let tmp = tempfile::tempdir().unwrap();
        let text = save_content(tmp.path(), pasteboard::Content::Text("hi".into())).unwrap();
        assert_eq!(text, tmp.path().join("Pasted Text.txt"));
        assert_eq!(fs::read_to_string(&text).unwrap(), "hi");
        let again = save_content(tmp.path(), pasteboard::Content::Text("yo".into())).unwrap();
        assert_eq!(again, tmp.path().join("Pasted Text 2.txt"));
        assert_eq!(fs::read_to_string(&text).unwrap(), "hi");
        let png = save_content(tmp.path(), pasteboard::Content::Png(vec![1, 2])).unwrap();
        assert_eq!(png, tmp.path().join("Pasted Image.png"));
    }

    #[test]
    fn dates_change_and_come_back() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("a.txt");
        fs::write(&f, b"x").unwrap();
        let before = crate::jobs::dates(&f).unwrap();
        let path = f.to_string_lossy().into_owned();
        // 2001-02-03 04:05:06 UTC and 2000-01-01.
        let out = tauri::async_runtime::block_on(set_dates(
            vec![path.clone()],
            Some(981_173_106_000.0),
            Some(946_684_800_000.0),
        ))
        .unwrap();
        assert_eq!(out.entries[0].modified_ms, 981_173_106_000);
        assert_eq!(crate::jobs::dates(&f).unwrap(), (981_173_106_000, Some(946_684_800_000)));
        let crate::jobs::UndoStep::Dates { modified_ms, created_ms, .. } = out.undo.steps[0].clone() else {
            panic!("not a dates step")
        };
        crate::jobs::set_dates(&f, Some(modified_ms), created_ms).unwrap();
        assert_eq!(crate::jobs::dates(&f).unwrap(), before);
        // Only the modified date: the created one stays (macOS moves it back
        // only when the modified date would come before it).
        crate::jobs::set_dates(&f, Some(2_000_000_000_000), None).unwrap();
        assert_eq!(crate::jobs::dates(&f).unwrap(), (2_000_000_000_000, before.1));
        crate::jobs::set_dates(&f, Some(1_000_000_000_000), None).unwrap();
        assert_eq!(crate::jobs::dates(&f).unwrap(), (1_000_000_000_000, Some(1_000_000_000_000)));
    }
}
