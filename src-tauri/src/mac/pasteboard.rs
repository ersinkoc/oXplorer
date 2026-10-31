//! File URLs on the general pasteboard, interoperable with Finder's ⌘C / ⌘V.

use std::path::{Path, PathBuf};

use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{
    NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardItem, NSPasteboardTypeFileURL,
    NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF, NSPasteboardWriting,
};
use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};

pub fn write_files(paths: &[PathBuf]) -> bool {
    autoreleasepool(|_| {
        let items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
            .iter()
            .filter_map(|p| {
                let url = NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()));
                let item = NSPasteboardItem::new();
                // SAFETY: NSPasteboardTypeFileURL is a valid, immutable framework constant.
                let ty = unsafe { NSPasteboardTypeFileURL };
                let url_string = url.absoluteString()?;
                item.setString_forType(&url_string, ty).then(|| ProtocolObject::from_retained(item))
            })
            .collect();
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        pb.writeObjects(&NSArray::from_retained_slice(&items))
    })
}

/// Local file paths currently on the pasteboard (from OXplorer, Finder, or any app).
pub fn read_files() -> Vec<PathBuf> {
    autoreleasepool(|_| {
        let Some(items) = NSPasteboard::generalPasteboard().pasteboardItems() else { return Vec::new() };
        // SAFETY: see `write_files`.
        let ty = unsafe { NSPasteboardTypeFileURL };
        items
            .iter()
            .filter_map(|item| {
                let s = item.stringForType(ty)?;
                // Finder writes file *reference* URLs (file:///.file/id=…); resolve them.
                let url = NSURL::URLWithString(&s)?.filePathURL()?;
                Some(PathBuf::from(url.path()?.to_string()))
            })
            .collect()
    })
}

/// Clipboard content that isn't files: a picture (as PNG) or text.
pub enum Content {
    Png(Vec<u8>),
    Text(String),
}

/// A picture or text on the pasteboard, picture first (screenshots, Preview's
/// Copy); TIFF pictures are re-encoded as PNG.
pub fn read_content() -> Option<Content> {
    autoreleasepool(|_| {
        let pb = NSPasteboard::generalPasteboard();
        // SAFETY: valid, immutable framework constants.
        let (png, tiff, string) =
            unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF, NSPasteboardTypeString) };
        if let Some(data) = pb.dataForType(png) {
            return Some(Content::Png(data.to_vec()));
        }
        if let Some(data) = pb.dataForType(tiff)
            && let Some(rep) = NSBitmapImageRep::imageRepWithData(&data)
            // SAFETY: an empty properties dictionary is always valid.
            && let Some(out) =
                unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
        {
            return Some(Content::Png(out.to_vec()));
        }
        let text = pb.stringForType(string)?.to_string();
        (!text.is_empty()).then_some(Content::Text(text))
    })
}

pub fn exists_all(paths: &[PathBuf]) -> bool {
    paths.iter().all(|p| Path::new(p).symlink_metadata().is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Overwrites the user's clipboard, so it only runs on request:
    /// `cargo test --lib pasteboard -- --ignored`
    #[test]
    #[ignore = "clobbers the real clipboard"]
    fn round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a b.txt");
        std::fs::write(&a, "").unwrap();
        // The general pasteboard may be unavailable in headless sessions.
        if !write_files(std::slice::from_ref(&a)) {
            eprintln!("pasteboard unavailable");
            return;
        }
        assert_eq!(read_files(), vec![a]);
    }
}
