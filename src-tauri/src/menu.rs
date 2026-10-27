use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};
use tauri_specta::Event as _;

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
];

const VIEW: &[Item] = &[
    ("view.asList", "as List", Some("CmdOrCtrl+1")),
    ("view.asIcons", "as Icons", Some("CmdOrCtrl+2")),
    SEP,
    ("pane.toggleDual", "Dual Pane", Some("CmdOrCtrl+U")),
    ("view.togglePreview", "Show Preview", Some("Shift+CmdOrCtrl+P")),
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
];

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let submenu = |title: &str, list: &[Item]| -> tauri::Result<Submenu<R>> {
        let menu = Submenu::new(app, title, true)?;
        for (id, title, accel) in list {
            if *id == "-" {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
            } else {
                menu.append(&MenuItem::with_id(app, *id, *title, true, *accel)?)?;
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
            &MenuItem::with_id(app, "app.settings", "Settings…", false, Some("CmdOrCtrl+Comma"))?,
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

pub fn forward_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Err(e) = (MenuCommand { id: id.to_owned() }).emit(app) {
        log::warn!("menu event {id} not delivered: {e}");
    }
}
