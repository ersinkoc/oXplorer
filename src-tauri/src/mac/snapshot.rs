//! Dev-only: the web view's rendering as a PNG, for the README screenshots
//! (`OX_SHOTS_DIR=/some/dir pnpm tauri dev`, see `src/dev/screenshots.ts`).
//! WebKit draws it itself, so no Screen Recording permission is needed; the
//! window frame and the sidebar's vibrancy (native, behind the page) aren't in it.

use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::msg_send;
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSError};

pub fn web_view_png(window: &tauri::WebviewWindow) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::sync_channel::<Option<Vec<u8>>>(1);
    window
        .with_webview(move |webview| {
            // SAFETY: `inner` is the live WKWebView; the closure runs on the main thread.
            let Some(view) = (unsafe { webview.inner().cast::<AnyObject>().as_ref() }) else {
                let _ = tx.try_send(None);
                return;
            };
            let handler = RcBlock::new(move |image: *mut NSImage, _err: *mut NSError| {
                // SAFETY: WebKit passes null or an image valid for the call's duration.
                let png = unsafe { image.as_ref() }.and_then(|i| autoreleasepool(|_| png_of(i)));
                let _ = tx.try_send(png);
            });
            // SAFETY: nil configuration snapshots the visible bounds; WebKit copies the block.
            unsafe {
                let _: () = msg_send![
                    view,
                    takeSnapshotWithConfiguration: std::ptr::null::<AnyObject>(),
                    completionHandler: &*handler
                ];
            }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(10)).ok().flatten().ok_or_else(|| "no snapshot".to_owned())
}

/// Every pixel of the image's best representation (2x on Retina).
fn png_of(image: &NSImage) -> Option<Vec<u8>> {
    // SAFETY: a null rect asks for the whole image; nil context/hints are allowed.
    let cg = unsafe { image.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }?;
    let rep = NSBitmapImageRep::initWithCGImage(<NSBitmapImageRep as objc2::AnyThread>::alloc(), &cg);
    // SAFETY: an empty property dictionary is valid for PNG encoding.
    let data =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(data.to_vec())
}
