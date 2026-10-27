//! Native file icons (NSWorkspace) and QuickLook thumbnails, encoded as PNG.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::AnyThread as _;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWorkspace};
use objc2_core_foundation::CGSize;
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_quick_look_thumbnailing::{
    QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes, QLThumbnailGenerator,
    QLThumbnailRepresentation,
};
use objc2_uniform_type_identifiers::UTType;

/// QuickLook can stall on slow volumes or exotic files; the caller falls back to the icon.
const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(4);

/// Icon of a specific file or folder (custom folder icons, app icons, special folders).
pub fn icon_for_path(path: &Path, px: u32) -> Option<Vec<u8>> {
    autoreleasepool(|_| {
        let ws = NSWorkspace::sharedWorkspace();
        let image = ws.iconForFile(&NSString::from_str(&path.to_string_lossy()));
        nsimage_to_png(&image, px)
    })
}

/// Generic icon for a filename extension (what Finder shows for e.g. any `.pdf`).
pub fn icon_for_extension(ext: &str, px: u32) -> Option<Vec<u8>> {
    autoreleasepool(|_| {
        let ty = UTType::typeWithFilenameExtension(&NSString::from_str(ext))?;
        let image = NSWorkspace::sharedWorkspace().iconForContentType(&ty);
        nsimage_to_png(&image, px)
    })
}

/// Content thumbnail (image, video frame, PDF page, …), or `None` if QuickLook has
/// nothing better than an icon.
pub fn thumbnail(path: &Path, px: u32) -> Option<Vec<u8>> {
    let (tx, rx) = mpsc::sync_channel::<Option<Vec<u8>>>(1);
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        // Request in points at 2x so the result is crisp on Retina.
        let points = f64::from(px) / 2.0;
        // SAFETY: plain initializer with valid arguments.
        let request = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                CGSize::new(points, points),
                2.0,
                QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
            )
        };
        let handler = RcBlock::new(move |rep: *mut QLThumbnailRepresentation, _err: *mut NSError| {
            // SAFETY: QuickLook passes either null or a valid representation for the call's duration.
            let png = unsafe { rep.as_ref() }.and_then(|r| {
                // SAFETY: a representation always carries a CGImage on macOS.
                let image = unsafe { r.CGImage() };
                cgimage_to_png(&image)
            });
            let _ = tx.try_send(png);
        });
        // SAFETY: the generator retains the request and copies the block.
        unsafe {
            QLThumbnailGenerator::sharedGenerator()
                .generateBestRepresentationForRequest_completionHandler(&request, &handler);
        }
    });
    rx.recv_timeout(THUMBNAIL_TIMEOUT).ok().flatten()
}

fn nsimage_to_png(image: &NSImage, px: u32) -> Option<Vec<u8>> {
    let side = f64::from(px);
    let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(side, side));
    // SAFETY: `rect` outlives the call; nil context/hints are allowed.
    let cg = unsafe { image.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
    cgimage_to_png(&cg)
}

fn cgimage_to_png(image: &CGImage) -> Option<Vec<u8>> {
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), image);
    // SAFETY: an empty property dictionary is valid for PNG encoding.
    let data =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
    Some(data.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_MAGIC: &[u8] = b"\x89PNG";

    #[test]
    fn folder_and_extension_icons() {
        let tmp = tempfile::tempdir().unwrap();
        let png = icon_for_path(tmp.path(), 64).expect("folder icon");
        assert!(png.starts_with(PNG_MAGIC));
        let png = icon_for_extension("pdf", 32).expect("pdf icon");
        assert!(png.starts_with(PNG_MAGIC));
    }

    #[test]
    fn thumbnail_of_an_image() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("icon.png");
        std::fs::write(&src, icon_for_extension("txt", 256).unwrap()).unwrap();
        let png = thumbnail(&src, 128).expect("thumbnail");
        assert!(png.starts_with(PNG_MAGIC));
    }
}
