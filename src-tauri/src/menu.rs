use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager as _, Runtime, State, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event as _;

use crate::error::{AppError, AppResult};

/// Emitted when a native menu item fires; `id` is a command-registry id on the frontend.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
pub struct MenuCommand {
    pub id: String,
}

/// (registry id, title, accelerator); an id of `-` is a separator.
type Item = (&'static str, &'static str, Option<&'static str>);
const SEP: Item = ("-", "", None);

const FILE: &[Item] = &[
    ("file.newFolder", "New Folder", Some("Shift+CmdOrCtrl+N")),
    ("file.newFile", "New File", Some("Alt+CmdOrCtrl+N")),
    ("tab.new", "New Tab", Some("CmdOrCtrl+T")),
    SEP,
    ("file.open", "Open", Some("CmdOrCtrl+O")),
    ("file.quickLook", "Quick Look", Some("CmdOrCtrl+Y")),
    ("file.revealInFinder", "Show in Finder", Some("Alt+CmdOrCtrl+R")),
    SEP,
    ("file.getInfo", "Get Info", Some("CmdOrCtrl+I")),
    ("file.rename", "Rename", None),
    ("file.duplicate", "Duplicate", Some("CmdOrCtrl+D")),
    ("file.copyPath", "Copy Path", Some("Alt+CmdOrCtrl+C")),
    ("file.compress.zip", "Compress", None),
    ("file.extract", "Extract Here", None),
    SEP,
    ("file.trash", "Move to Trash", Some("CmdOrCtrl+Backspace")),
    ("file.delete", "Delete Immediately…", Some("Alt+CmdOrCtrl+Backspace")),
    SEP,
    ("file.copyToOther", "Copy to Other Pane", Some("F5")),
    ("file.moveToOther", "Move to Other Pane", Some("F6")),
    SEP,
    ("tab.close", "Close Tab", Some("CmdOrCtrl+W")),
    ("window.close", "Close Window", Some("Shift+CmdOrCtrl+W")),
];

/// Tab/pane items; `Tab` alone (switch pane) is handled by the file view, not
/// the menu, so it keeps working for focus navigation in text fields and dialogs.
const WINDOW: &[Item] = &[
    ("tab.prev", "Show Previous Tab", Some("Ctrl+Shift+Tab")),
    ("tab.next", "Show Next Tab", Some("Ctrl+Tab")),
    ("tab.moveToOtherPane", "Move Tab to Other Pane", None),
    SEP,
    ("pane.switch", "Switch to Other Pane", None),
    ("pane.swap", "Swap Panes", None),
];

/// Text fields get these too: the frontend forwards them when an input has focus.
const EDIT: &[Item] = &[
    ("edit.undo", "Undo", Some("CmdOrCtrl+Z")),
    ("edit.redo", "Redo", Some("Shift+CmdOrCtrl+Z")),
    SEP,
    ("edit.cut", "Cut", Some("CmdOrCtrl+X")),
    ("edit.copy", "Copy", Some("CmdOrCtrl+C")),
    ("edit.paste", "Paste", Some("CmdOrCtrl+V")),
    ("edit.pasteMove", "Move Item Here", Some("Alt+CmdOrCtrl+V")),
    ("edit.selectAll", "Select All", Some("CmdOrCtrl+A")),
    SEP,
    ("view.find", "Find", Some("CmdOrCtrl+F")),
    ("search.open", "Search…", Some("Shift+CmdOrCtrl+F")),
];

const VIEW: &[Item] = &[
    ("view.asList", "as List", Some("CmdOrCtrl+1")),
    ("view.asIcons", "as Icons", Some("CmdOrCtrl+2")),
    ("view.asColumns", "as Columns", Some("CmdOrCtrl+3")),
    SEP,
    ("pane.toggleDual", "Dual Pane", Some("CmdOrCtrl+U")),
    ("view.togglePreview", "Show Preview", Some("Shift+CmdOrCtrl+P")),
    ("terminal.toggle", "Show Terminal", Some("Ctrl+Backquote")),
    ("terminal.new", "New Terminal", Some("Ctrl+Shift+Backquote")),
    ("terminal.cdToPane", "Go to Folder in Terminal", None),
    SEP,
    ("view.toggleHidden", "Show Hidden Files", Some("Shift+CmdOrCtrl+Period")),
    ("view.toggleSidebar", "Toggle Sidebar", Some("Ctrl+CmdOrCtrl+S")),
    ("view.reload", "Reload", Some("CmdOrCtrl+R")),
];

const GO: &[Item] = &[
    ("nav.back", "Back", Some("CmdOrCtrl+BracketLeft")),
    ("nav.forward", "Forward", Some("CmdOrCtrl+BracketRight")),
    ("nav.up", "Enclosing Folder", Some("CmdOrCtrl+Up")),
    ("nav.home", "Home", Some("Shift+CmdOrCtrl+H")),
    ("nav.goToFolder", "Go to Folder…", Some("Shift+CmdOrCtrl+G")),
    ("palette.open", "Command Palette…", Some("CmdOrCtrl+K")),
];

const SETTINGS: Item = ("app.settings", "Settings…", Some("CmdOrCtrl+Comma"));

/// Customizable items by menu, in menu order.
const MENUS: &[(&str, &[Item])] = &[
    ("OXplorer", &[SETTINGS]),
    ("File", FILE),
    ("Edit", EDIT),
    ("View", VIEW),
    ("Go", GO),
    ("Window", WINDOW),
];

/// User-chosen accelerators by item id; `None` means "no shortcut".
pub type Overrides = HashMap<String, Option<String>>;

#[derive(Default)]
pub struct Shortcuts(Mutex<Overrides>);

fn accelerator<'a>(id: &str, default: Option<&'a str>, overrides: &'a Overrides) -> Option<&'a str> {
    match overrides.get(id) {
        Some(custom) => custom.as_deref(),
        None => default,
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    build_with(app, &Overrides::new())
}

fn build_with<R: Runtime>(app: &AppHandle<R>, overrides: &Overrides) -> tauri::Result<Menu<R>> {
    let item = |(id, title, accel): &Item| {
        MenuItem::with_id(app, *id, *title, true, accelerator(id, *accel, overrides))
    };
    let submenu = |title: &str, list: &[Item]| -> tauri::Result<Submenu<R>> {
        let menu = Submenu::new(app, title, true)?;
        for entry in list {
            if entry.0 == "-" {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
            } else {
                menu.append(&item(entry)?)?;
            }
        }
        Ok(menu)
    };

    let app_menu = Submenu::with_items(
        app,
        "OXplorer",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About OXplorer"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &item(&SETTINGS)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // ⌘W closes a tab here; "Close Window" (⇧⌘W) lives in the File menu.
    let window = submenu("Window", WINDOW)?;
    window.prepend_items(&[
        &PredefinedMenuItem::minimize(app, None)?,
        &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
        &PredefinedMenuItem::fullscreen(app, None)?,
        &PredefinedMenuItem::separator(app)?,
    ])?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &submenu("File", FILE)?,
            &submenu("Edit", EDIT)?,
            &submenu("View", VIEW)?,
            &submenu("Go", GO)?,
            &window,
        ],
    )
}

/// A customizable menu item, for the Shortcuts settings.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MenuEntry {
    pub id: String,
    pub title: String,
    pub menu: String,
    pub default_accelerator: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub fn menu_items() -> Vec<MenuEntry> {
    MENUS
        .iter()
        .flat_map(|(menu, items)| {
            items.iter().filter(|(id, ..)| *id != "-").map(move |(id, title, accel)| MenuEntry {
                id: (*id).into(),
                title: (*title).into(),
                menu: (*menu).into(),
                default_accelerator: accel.map(Into::into),
            })
        })
        .collect()
}

fn invalid(message: String) -> AppError {
    AppError::InvalidQuery { message }
}

/// Checks overrides: known ids, parseable accelerators, no shortcut used twice.
pub fn validate(overrides: &Overrides) -> AppResult<()> {
    let items: Vec<&Item> = MENUS.iter().flat_map(|(_, items)| items.iter()).filter(|i| i.0 != "-").collect();
    for id in overrides.keys() {
        if !items.iter().any(|i| i.0 == id) {
            return Err(invalid(format!("unknown menu item {id}")));
        }
    }
    let mut seen: Vec<(muda::accelerator::Accelerator, &str)> = Vec::new();
    for (id, title, default) in items {
        let Some(text) = accelerator(id, *default, overrides) else { continue };
        let parsed: muda::accelerator::Accelerator =
            text.parse().map_err(|e| invalid(format!("“{text}” isn’t a valid shortcut: {e}")))?;
        if let Some((_, other)) = seen.iter().find(|(a, _)| *a == parsed) {
            return Err(invalid(format!("“{text}” is used by both “{other}” and “{title}”")));
        }
        seen.push((parsed, title));
    }
    Ok(())
}

/// Rebuilds the menu bar with the user's shortcuts.
#[tauri::command]
#[specta::specta]
pub fn set_shortcuts(app: AppHandle, state: State<'_, Shortcuts>, shortcuts: Overrides) -> AppResult<()> {
    validate(&shortcuts)?;
    let menu = build_with(&app, &shortcuts).map_err(|e| invalid(e.to_string()))?;
    app.set_menu(menu).map_err(|e| invalid(e.to_string()))?;
    if let Ok(mut current) = state.0.lock() {
        *current = shortcuts;
    }
    Ok(())
}

/// Shows the settings window, creating it the first time.
#[tauri::command]
#[specta::specta]
pub async fn open_settings(app: AppHandle) -> AppResult<()> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        return w.set_focus().map_err(|e| invalid(e.to_string()));
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .inner_size(680.0, 520.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .build()
        .map(|_| ())
        .map_err(|e| invalid(e.to_string()))
}

pub fn forward_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Err(e) = (MenuCommand { id: id.to_owned() }).emit(app) {
        log::warn!("menu event {id} not delivered: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(pairs: &[(&str, Option<&str>)]) -> Overrides {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), v.map(str::to_owned))).collect()
    }

    #[test]
    fn defaults_are_valid_and_unique() {
        validate(&Overrides::new()).unwrap();
        assert!(menu_items().iter().any(|m| m.id == "file.newFolder" && m.menu == "File"));
    }

    #[test]
    fn rejects_bad_or_conflicting_shortcuts() {
        assert!(validate(&o(&[("file.rename", Some("Cmd+Shift+R"))])).is_ok());
        assert!(validate(&o(&[("file.rename", Some("Cmd+Nonsense"))])).is_err());
        assert!(validate(&o(&[("no.such", None)])).is_err());
        // ⌘D is Duplicate already.
        let err = validate(&o(&[("file.rename", Some("CmdOrCtrl+D"))])).unwrap_err();
        assert!(err.to_string().contains("Duplicate"), "{err}");
        // Freeing it first makes it available.
        assert!(validate(&o(&[("file.rename", Some("CmdOrCtrl+D")), ("file.duplicate", None)])).is_ok());
    }
}
