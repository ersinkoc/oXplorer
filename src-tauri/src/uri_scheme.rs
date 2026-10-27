//! `oxthumb://` serves icons and thumbnails as `<img src>` so image bytes never
//! go through JSON IPC. URL shapes (all `px` are pixel sizes, path percent-encoded):
//!
//! - `oxthumb://localhost/ext/<px>/<extension>`  generic icon for a file type
//! - `oxthumb://localhost/path/<px>/<path>`      icon of a specific file/folder
//! - `oxthumb://localhost/thumb/<px>/<path>`     QuickLook thumbnail, falling back to the icon

use std::collections::HashMap;
use std::fs;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use percent_encoding::percent_decode_str;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager as _, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::mac::images;
use crate::security::validate_path;

pub const SCHEME: &str = "oxthumb";

const ALLOWED_SIZES: &[u32] = &[16, 32, 64, 128, 256, 512, 1024];
/// Icons are small and repeat a lot (one per extension); a flat map with a cap is enough.
const MEMORY_CACHE_LIMIT: usize = 4096;

/// Separate from rayon's global pool so slow QuickLook calls can't stall directory listing.
static POOL: LazyLock<rayon::ThreadPool> = LazyLock::new(|| {
    rayon::ThreadPoolBuilder::new()
        .num_threads(4)
        .thread_name(|i| format!("oxthumb-{i}"))
        .build()
        .expect("thumbnail thread pool")
});

static MEMORY: LazyLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = LazyLock::new(Mutex::default);

#[derive(Debug, PartialEq, Eq)]
enum Asset {
    Extension { ext: String, px: u32 },
    PathIcon { path: PathBuf, px: u32 },
    Thumbnail { path: PathBuf, px: u32 },
}

fn parse(uri_path: &str) -> Option<Asset> {
    let mut parts = uri_path.trim_start_matches('/').splitn(3, '/');
    let kind = parts.next()?;
    let px: u32 = parts.next()?.parse().ok().filter(|px| ALLOWED_SIZES.contains(px))?;
    let rest = percent_decode_str(parts.next()?).decode_utf8().ok()?;
    match kind {
        "ext" if !rest.is_empty() && !rest.contains('/') => {
            Some(Asset::Extension { ext: rest.into_owned(), px })
        }
        "path" => Some(Asset::PathIcon { path: validate_path(&rest).ok()?, px }),
        "thumb" => Some(Asset::Thumbnail { path: validate_path(&rest).ok()?, px }),
        _ => None,
    }
}

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let cache_dir = ctx.app_handle().path().app_cache_dir().ok().map(|d| d.join("thumbs"));
    let uri_path = request.uri().path().to_owned();
    POOL.spawn(move || {
        let bytes = parse(&uri_path).and_then(|asset| render(&asset, cache_dir.as_deref()));
        responder.respond(
            match bytes {
                Some(png) => Response::builder()
                    .header("Content-Type", "image/png")
                    // Thumbnail URLs carry the file's mtime, so they're safe to cache hard.
                    .header("Cache-Control", "max-age=31536000, immutable")
                    .body(png.to_vec()),
                None => {
                    log::debug!("oxthumb: nothing for {uri_path}");
                    Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new())
                }
            }
            .unwrap_or_else(|_| Response::new(Vec::new())),
        );
    });
}

fn render(asset: &Asset, cache_dir: Option<&Path>) -> Option<Arc<Vec<u8>>> {
    match asset {
        Asset::Extension { ext, px } => {
            memoized(format!("ext:{}:{px}", ext.to_lowercase()), || images::icon_for_extension(ext, *px))
        }
        Asset::PathIcon { path, px } => {
            // Folder/app icons can change (custom icons, app updates): key by mtime too.
            let stamp = fs::metadata(path).map(|m| m.mtime()).unwrap_or_default();
            memoized(format!("path:{}:{stamp}:{px}", path.display()), || images::icon_for_path(path, *px))
        }
        Asset::Thumbnail { path, px } => thumbnail_cached(path, *px, cache_dir)
            .map(Arc::new)
            .or_else(|| render(&Asset::PathIcon { path: path.clone(), px: *px }, cache_dir)),
    }
}

fn memoized(key: String, make: impl FnOnce() -> Option<Vec<u8>>) -> Option<Arc<Vec<u8>>> {
    if let Some(hit) = MEMORY.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
        return Some(Arc::clone(hit));
    }
    let value = Arc::new(make()?);
    let mut map = MEMORY.lock().unwrap_or_else(PoisonError::into_inner);
    if map.len() >= MEMORY_CACHE_LIMIT {
        map.clear();
    }
    map.insert(key, Arc::clone(&value));
    Some(value)
}

/// Thumbnails are cached on disk keyed by path + size + mtime + length, so an
/// edited file gets a fresh thumbnail and unchanged ones load instantly.
fn thumbnail_cached(path: &Path, px: u32, cache_dir: Option<&Path>) -> Option<Vec<u8>> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mut h = DefaultHasher::new();
    (path, px, meta.mtime(), meta.mtime_nsec(), meta.len()).hash(&mut h);
    let file = cache_dir.map(|d| d.join(format!("{:016x}.png", h.finish())));

    if let Some(hit) = file.as_deref().and_then(|f| fs::read(f).ok()) {
        return Some(hit);
    }
    let png = images::thumbnail(path, px)?;
    if let (Some(file), Some(dir)) = (file.as_deref(), cache_dir) {
        // Best effort: a failed cache write only costs a regeneration next time.
        let _ = fs::create_dir_all(dir).and_then(|()| fs::write(file, &png));
    }
    Some(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls() {
        assert_eq!(parse("/ext/32/pdf"), Some(Asset::Extension { ext: "pdf".into(), px: 32 }));
        assert_eq!(
            parse("/thumb/128/%2FUsers%2Fa%2Fphoto%20one.jpg"),
            Some(Asset::Thumbnail { path: "/Users/a/photo one.jpg".into(), px: 128 })
        );
        assert_eq!(parse("/path/64/%2Ftmp"), Some(Asset::PathIcon { path: "/tmp".into(), px: 64 }));
        // Unsupported sizes, traversal and relative paths are rejected.
        assert_eq!(parse("/ext/33/pdf"), None);
        assert_eq!(parse("/path/32/%2Fa%2F..%2Fetc"), None);
        assert_eq!(parse("/thumb/32/relative"), None);
        assert_eq!(parse("/ext/32/a%2Fb"), None);
        assert_eq!(parse("/other/32/x"), None);
    }

    #[test]
    fn thumbnail_falls_back_to_icon_and_caches() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("notes.unknownext");
        fs::write(&file, "hello").unwrap();
        let png = render(&Asset::Thumbnail { path: file, px: 64 }, Some(&tmp.path().join("cache")));
        assert!(png.is_some_and(|p| p.starts_with(b"\x89PNG")));
    }
}
