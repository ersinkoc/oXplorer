//! The system Quick Look panel (Space / ⌘Y), fed with the frontend's selection.
//!
//! The panel only talks to a "controller" it finds in the responder chain, so the
//! main window's class gets the three `QLPreviewPanelController` methods added at
//! startup; they hand the panel our data source.

use std::cell::{OnceCell, RefCell};
use std::ffi::CString;
use std::path::PathBuf;
use std::sync::OnceLock;

use objc2::encode::{Encode as _, Encoding};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{DefinedClass as _, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{NSEvent, NSEventType, NSWindowDelegate};
use objc2_foundation::{NSInteger, NSString, NSURL};
use objc2_quick_look_ui::{QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource, QLPreviewPanelDelegate};
use tauri::{AppHandle, Runtime};

use crate::model::{QuickLookKey, QuickLookState};

static APP: OnceLock<AppHandle<tauri::Wry>> = OnceLock::new();

thread_local! {
    static SOURCE: OnceCell<Retained<Source>> = const { OnceCell::new() };
}

pub struct SourceIvars {
    items: RefCell<Vec<Retained<NSURL>>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "OXQuickLookSource"]
    #[ivars = SourceIvars]
    struct Source;

    unsafe impl NSObjectProtocol for Source {}

    unsafe impl QLPreviewPanelDataSource for Source {
        #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
        fn count(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
            NSInteger::try_from(self.ivars().items.borrow().len()).unwrap_or(0)
        }

        #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
        fn item(
            &self,
            _panel: Option<&QLPreviewPanel>,
            index: NSInteger,
        ) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
            self.item_at(index)
        }
    }

    unsafe impl NSWindowDelegate for Source {}

    unsafe impl QLPreviewPanelDelegate for Source {
        /// Arrow keys pressed while the panel is key move the selection in the
        /// pane (the frontend then sends the new item); Space closes, like Finder.
        #[unsafe(method(previewPanel:handleEvent:))]
        fn handle_event(&self, panel: Option<&QLPreviewPanel>, event: Option<&NSEvent>) -> bool {
            handle_key(panel, event)
        }
    }
);

impl Source {
    fn item_at(&self, index: NSInteger) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
        let items = self.ivars().items.borrow();
        let url = items.get(usize::try_from(index).ok()?)?;
        Some(ProtocolObject::from_retained(url.clone()))
    }

    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(SourceIvars { items: RefCell::new(Vec::new()) });
        // SAFETY: NSObject's `init` on a freshly allocated instance.
        unsafe { msg_send![super(this), init] }
    }
}

fn handle_key(panel: Option<&QLPreviewPanel>, event: Option<&NSEvent>) -> bool {
    let Some(event) = event else { return false };
    if event.r#type() != NSEventType::KeyDown {
        return false;
    }
    let key = match event.keyCode() {
        123 => "ArrowLeft",
        124 => "ArrowRight",
        125 => "ArrowDown",
        126 => "ArrowUp",
        49 => {
            if let Some(panel) = panel {
                panel.orderOut(None);
            }
            return true;
        }
        _ => return false,
    };
    emit(QuickLookKey {
        key: key.to_owned(),
        shift: event.modifierFlags().contains(objc2_app_kit::NSEventModifierFlags::Shift),
    });
    true
}

fn source(mtm: MainThreadMarker) -> Retained<Source> {
    SOURCE.with(|s| s.get_or_init(|| Source::new(mtm)).clone())
}

fn emit<E: tauri_specta::Event + serde::Serialize + Clone>(event: E) {
    if let Some(app) = APP.get()
        && let Err(e) = event.emit(app)
    {
        log::warn!("quick look event not delivered: {e}");
    }
}

extern "C-unwind" fn accepts_control(_this: &AnyObject, _cmd: Sel, _panel: *mut AnyObject) -> Bool {
    Bool::YES
}

extern "C-unwind" fn begin_control(_this: &AnyObject, _cmd: Sel, panel: *mut AnyObject) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    // SAFETY: AppKit passes the shared QLPreviewPanel.
    let Some(panel) = (unsafe { panel.cast::<QLPreviewPanel>().as_ref() }) else { return };
    let src = source(mtm);
    // SAFETY: the source lives for the whole process (thread-local, main thread).
    unsafe {
        panel.setDataSource(Some(ProtocolObject::from_ref(&*src)));
        panel.setDelegate(Some(&src));
    }
    emit(QuickLookState { visible: true });
}

extern "C-unwind" fn end_control(_this: &AnyObject, _cmd: Sel, panel: *mut AnyObject) {
    // SAFETY: AppKit passes the shared QLPreviewPanel.
    if let Some(panel) = unsafe { panel.cast::<QLPreviewPanel>().as_ref() } {
        // SAFETY: clearing the panel's weak references.
        unsafe {
            panel.setDataSource(None);
            panel.setDelegate(None);
        }
    }
    emit(QuickLookState { visible: false });
}

fn add_method(cls: &AnyClass, sel: Sel, imp: objc2::runtime::Imp, ret: &Encoding) {
    let obj = <*mut AnyObject>::ENCODING;
    let Ok(types) = CString::new(format!("{ret}{obj}{}{obj}", Sel::ENCODING)) else { return };
    // SAFETY: `imp` matches the encoded signature (self, _cmd, one object argument).
    let added =
        unsafe { objc2::ffi::class_addMethod(std::ptr::from_ref(cls).cast_mut(), sel, imp, types.as_ptr()) };
    if !added.as_bool() {
        log::warn!("quick look: {sel} already present on {}", cls.name().to_string_lossy());
    }
}

/// Makes the main window the panel's controller. Must run on the main thread.
pub fn install<R: Runtime>(app: &AppHandle<tauri::Wry>, window: &tauri::WebviewWindow<R>) {
    let _ = APP.set(app.clone());
    let Ok(ns_window) = window.ns_window() else { return };
    // SAFETY: `ns_window` is the live NSWindow of the main webview window.
    let Some(obj) = (unsafe { ns_window.cast::<AnyObject>().as_ref() }) else { return };
    let cls = obj.class();
    type Accepts = extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> Bool;
    type Control = extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject);
    // SAFETY: function pointers are reinterpreted as the untyped `Imp` the runtime stores.
    unsafe {
        add_method(
            cls,
            sel!(acceptsPreviewPanelControl:),
            std::mem::transmute::<Accepts, objc2::runtime::Imp>(accepts_control),
            &Bool::ENCODING,
        );
        add_method(
            cls,
            sel!(beginPreviewPanelControl:),
            std::mem::transmute::<Control, objc2::runtime::Imp>(begin_control),
            &Encoding::Void,
        );
        add_method(
            cls,
            sel!(endPreviewPanelControl:),
            std::mem::transmute::<Control, objc2::runtime::Imp>(end_control),
            &Encoding::Void,
        );
    }
}

/// Shows `paths` (opening the panel when `open`), or only refreshes it when it's
/// already visible. Must run on the main thread.
pub fn present(paths: &[PathBuf], index: usize, open: bool) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    // SAFETY: plain class/property calls on the main thread.
    unsafe {
        let Some(panel) = QLPreviewPanel::sharedPreviewPanel(mtm) else { return };
        let visible = panel.isVisible();
        if !visible && !open {
            return;
        }
        let src = source(mtm);
        *src.ivars().items.borrow_mut() =
            paths.iter().map(|p| NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()))).collect();
        if !visible {
            panel.makeKeyAndOrderFront(None);
        }
        panel.reloadData();
        panel.setCurrentPreviewItemIndex(NSInteger::try_from(index).unwrap_or(0));
    }
}

pub fn close() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    // SAFETY: only touches the panel if it was created.
    unsafe {
        if QLPreviewPanel::sharedPreviewPanelExists(mtm)
            && let Some(panel) = QLPreviewPanel::sharedPreviewPanel(mtm)
            && panel.isVisible()
        {
            panel.orderOut(None);
        }
    }
}

/// Whether the panel is on screen (for the self-test).
pub fn is_visible() -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    // SAFETY: see `close`.
    unsafe {
        QLPreviewPanel::sharedPreviewPanelExists(mtm)
            && QLPreviewPanel::sharedPreviewPanel(mtm).is_some_and(|p| p.isVisible())
    }
}
