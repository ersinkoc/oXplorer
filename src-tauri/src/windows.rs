//! More browser windows (File → New Window, ⌘N). Each is built from the main
//! window's config under a `window-<n>` label; the folder it starts in waits
//! here until its page asks for it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Manager as _, WebviewWindow, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::security::validate_path;

static START_PATHS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

/// Offset from the window it was opened from, like Finder's cascade.
const CASCADE: f64 = 28.0;

fn failed(e: impl std::fmt::Display) -> AppError {
    AppError::Io { path: None, message: format!("couldn’t open a window: {e}") }
}

/// Opens a new browser window showing `path`.
#[tauri::command]
#[specta::specta]
pub async fn open_window(app: AppHandle, path: String) -> AppResult<()> {
    let path = validate_path(&path)?;
    // Picked and reserved under one lock, so two quick ⌘Ns get different labels.
    let label = {
        let mut starts = START_PATHS.lock().map_err(failed)?;
        let label = (2..)
            .map(|n| format!("window-{n}"))
            .find(|l| app.get_webview_window(l).is_none() && !starts.contains_key(l))
            .ok_or_else(|| failed("no free label"))?;
        starts.insert(label.clone(), path.to_string_lossy().into_owned());
        label
    };
    let built = build(&app, &label);
    if built.is_err()
        && let Ok(mut m) = START_PATHS.lock()
    {
        m.remove(&label);
    }
    built
}

fn build(app: &AppHandle, label: &str) -> AppResult<()> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| failed("no window config"))?;
    label.clone_into(&mut config.label);
    // Below and to the right of the focused window; the window-state plugin
    // restores the size and place of a label used before.
    let from = app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false));
    if let Some(w) = from
        && let (Ok(pos), Ok(scale)) = (w.outer_position(), w.scale_factor())
    {
        let pos = pos.to_logical::<f64>(scale);
        config.x = Some(pos.x + CASCADE);
        config.y = Some(pos.y + CASCADE);
    }
    WebviewWindowBuilder::from_config(app, &config).and_then(WebviewWindowBuilder::build).map_err(failed)?;
    Ok(())
}

/// The folder a window opened with `open_window` starts in (asked once, by its page).
#[tauri::command]
#[specta::specta]
pub fn window_start_path(window: WebviewWindow) -> Option<String> {
    START_PATHS.lock().ok().and_then(|mut m| m.remove(window.label()))
}

/// The browser window that should handle app-level requests (Dock, Finder
/// extension, second launch): the main one, or else any other browser window.
pub fn primary(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main").or_else(|| {
        let mut others: Vec<_> =
            app.webview_windows().into_iter().filter(|(l, _)| l.starts_with("window-")).collect();
        others.sort_by(|a, b| a.0.cmp(&b.0));
        others.into_iter().next().map(|(_, w)| w)
    })
}
