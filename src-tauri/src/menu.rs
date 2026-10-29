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
    ("window.new", "New Window", Some("CmdOrCtrl+N")),
    ("file.newFolder", "New Folder", Some("Shift+CmdOrCtrl+N")),
    ("file.newFolderWithSelection", "New Folder with Selection", Some("Ctrl+CmdOrCtrl+N")),
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
    ("file.makeAlias", "Make Alias", Some("Ctrl+CmdOrCtrl+A")),
    ("file.convertImage", "Convert Image…", None),
    ("file.copyPath", "Copy Path", Some("Alt+CmdOrCtrl+C")),
    ("file.addToSidebar", "Add to Sidebar", Some("Ctrl+CmdOrCtrl+T")),
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
    ("tab.reopen", "Reopen Closed Tab", Some("Shift+CmdOrCtrl+T")),
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
    ("pane.syncBrowse", "Synchronized Browsing", None),
    SEP,
    ("pane.compare", "Compare Panes", None),
    ("pane.selectDifferences", "Select Differences", None),
    ("pane.synchronize", "Synchronize Folders…", None),
    ("file.compareFiles", "Compare Files", None),
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
    ("edit.deselectAll", "Deselect All", Some("Alt+CmdOrCtrl+A")),
    ("edit.invertSelection", "Invert Selection", None),
    ("edit.selectMatching", "Select Matching…", None),
    SEP,
    ("view.find", "Find", Some("CmdOrCtrl+F")),
    ("search.open", "Search…", Some("Shift+CmdOrCtrl+F")),
];

const VIEW: &[Item] = &[
    ("view.asList", "as List", Some("CmdOrCtrl+1")),
    ("view.asIcons", "as Icons", Some("CmdOrCtrl+2")),
    ("view.asColumns", "as Columns", Some("CmdOrCtrl+3")),
    ("view.biggerIcons", "Bigger Icons", Some("CmdOrCtrl+Equal")),
    ("view.smallerIcons", "Smaller Icons", Some("CmdOrCtrl+Minus")),
    SEP,
    ("view.sortName", "Sort by Name", Some("Ctrl+Alt+CmdOrCtrl+1")),
    ("view.sortKind", "Sort by Kind", Some("Ctrl+Alt+CmdOrCtrl+2")),
    ("view.sortModified", "Sort by Date Modified", Some("Ctrl+Alt+CmdOrCtrl+5")),
    ("view.sortSize", "Sort by Size", Some("Ctrl+Alt+CmdOrCtrl+7")),
    ("view.foldersFirst", "Keep Folders on Top", None),
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
    ("view.diskUsage", "Disk Usage…", Some("Alt+CmdOrCtrl+D")),
    ("view.findDuplicates", "Find Duplicates…", None),
    ("view.calculateSizes", "Calculate Folder Sizes", Some("Alt+CmdOrCtrl+S")),
];

const GO: &[Item] = &[
    ("nav.back", "Back", Some("CmdOrCtrl+BracketLeft")),
    ("nav.forward", "Forward", Some("CmdOrCtrl+BracketRight")),
    ("nav.up", "Enclosing Folder", Some("CmdOrCtrl+Up")),
    ("nav.documents", "Documents", Some("Shift+CmdOrCtrl+O")),
    ("nav.desktop", "Desktop", Some("Shift+CmdOrCtrl+D")),
    ("nav.downloads", "Downloads", Some("Alt+CmdOrCtrl+L")),
    ("nav.home", "Home", Some("Shift+CmdOrCtrl+H")),
    ("nav.applications", "Applications", Some("Shift+CmdOrCtrl+A")),
    ("nav.utilities", "Utilities", Some("Shift+CmdOrCtrl+U")),
    ("nav.recentFolders", "Recent Folders", None),
    ("nav.goToFolder", "Go to Folder…", Some("Shift+CmdOrCtrl+G")),
    ("palette.open", "Command Palette…", Some("CmdOrCtrl+K")),
];

const SETTINGS: Item = ("app.settings", "Settings…", Some("CmdOrCtrl+Comma"));
const CHECK_UPDATES: Item = ("app.checkUpdates", "Check for Updates…", None);

const HELP: &[Item] = &[
    ("help.whatsNew", "What’s New in OXplorer", None),
    SEP,
    ("help.report", "Report a Problem…", None),
    ("help.showLog", "Show Log File", None),
];

/// Customizable items by menu, in menu order.
const MENUS: &[(&str, &[Item])] = &[
    ("OXplorer", &[SETTINGS, CHECK_UPDATES]),
    ("File", FILE),
    ("Edit", EDIT),
    ("View", VIEW),
    ("Go", GO),
    ("Window", WINDOW),
    ("Help", HELP),
];

/// User-chosen accelerators by item id; `None` means "no shortcut".
pub type Overrides = HashMap<String, Option<String>>;

/// Translated labels keyed by their English text (sent by the frontend).
pub type Titles = HashMap<String, String>;

/// What the menu bar is currently built with.
#[derive(Default)]
pub struct MenuConfig(Mutex<(Overrides, Titles)>);

fn accelerator<'a>(id: &str, default: Option<&'a str>, overrides: &'a Overrides) -> Option<&'a str> {
    match overrides.get(id) {
        Some(custom) => custom.as_deref(),
        None => default,
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    build_with(app, &Overrides::new(), &Titles::new())
}

fn build_with<R: Runtime>(
    app: &AppHandle<R>,
    overrides: &Overrides,
    titles: &Titles,
) -> tauri::Result<Menu<R>> {
    let l = |en: &'static str| -> String { titles.get(en).cloned().unwrap_or_else(|| en.to_owned()) };
    let item = |(id, title, accel): &Item| {
        MenuItem::with_id(app, *id, l(title), true, accelerator(id, *accel, overrides))
    };
    let submenu = |title: &'static str, list: &[Item]| -> tauri::Result<Submenu<R>> {
        let menu = Submenu::new(app, l(title), true)?;
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
            &PredefinedMenuItem::about(app, Some(&l("About OXplorer")), None)?,
            &item(&CHECK_UPDATES)?,
            &PredefinedMenuItem::separator(app)?,
            &item(&SETTINGS)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(&l("Services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&l("Hide OXplorer")))?,
            &PredefinedMenuItem::hide_others(app, Some(&l("Hide Others")))?,
            &PredefinedMenuItem::show_all(app, Some(&l("Show All")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&l("Quit OXplorer")))?,
        ],
    )?;

    // ⌘W closes a tab here; "Close Window" (⇧⌘W) lives in the File menu.
    let window = submenu("Window", WINDOW)?;
    window.prepend_items(&[
        &PredefinedMenuItem::minimize(app, Some(&l("Minimize")))?,
        &PredefinedMenuItem::maximize(app, Some(&l("Zoom")))?,
        &PredefinedMenuItem::fullscreen(app, Some(&l("Enter Full Screen")))?,
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
            &submenu("Help", HELP)?,
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

fn rebuild(app: &AppHandle, overrides: &Overrides, titles: &Titles) -> AppResult<()> {
    let menu = build_with(app, overrides, titles).map_err(|e| invalid(e.to_string()))?;
    app.set_menu(menu).map(|_| ()).map_err(|e| invalid(e.to_string()))
}

/// Rebuilds the menu bar with the user's shortcuts.
#[tauri::command]
#[specta::specta]
pub fn set_shortcuts(app: AppHandle, state: State<'_, MenuConfig>, shortcuts: Overrides) -> AppResult<()> {
    validate(&shortcuts)?;
    let mut config = state.0.lock().map_err(|e| invalid(e.to_string()))?;
    rebuild(&app, &shortcuts, &config.1)?;
    config.0 = shortcuts;
    Ok(())
}

/// Rebuilds the menu bar in the UI language (labels keyed by their English text).
#[tauri::command]
#[specta::specta]
pub fn set_menu_titles(app: AppHandle, state: State<'_, MenuConfig>, titles: Titles) -> AppResult<()> {
    let mut config = state.0.lock().map_err(|e| invalid(e.to_string()))?;
    rebuild(&app, &config.0, &titles)?;
    config.1 = titles;
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
