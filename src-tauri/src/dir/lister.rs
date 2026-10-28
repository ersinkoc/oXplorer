use std::fs::{self, DirEntry, Metadata};
use std::os::macos::fs::MetadataExt as _;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rayon::prelude::*;

use crate::error::{AppError, AppResult};
use crate::mac::tags::read_tags;
use crate::model::{DirEvent, EntryKind, FileEntry, SymlinkInfo, TaggedPath};

/// Small first batch so the list paints immediately; larger ones after that
/// to keep IPC overhead low.
const FIRST_BATCH: usize = 200;
const BATCH: usize = 1000;

const UF_HIDDEN: u32 = 0x8000;
/// Paths checked per `Tags` event round.
const TAG_CHUNK: usize = 2000;

/// Whether a directory at `path` is shown as a single document (by extension).
pub fn is_package_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| PACKAGE_EXTENSIONS.iter().any(|p| p.eq_ignore_ascii_case(ext)))
}

const PACKAGE_EXTENSIONS: &[&str] = &[
    "app",
    "appex",
    "bundle",
    "framework",
    "plugin",
    "kext",
    "photoslibrary",
    "musiclibrary",
    "xcodeproj",
    "xcworkspace",
    "playground",
    "pkg",
    "mpkg",
    "rtfd",
    "scptd",
    "prefpane",
    "qlgenerator",
    "mdimporter",
    "saver",
    "wdgt",
    "xpc",
    "systemextension",
    "fcpbundle",
    "logicx",
    "band",
    "pages",
    "numbers",
    "key",
    "imovielibrary",
];

/// Streams `dir` to `emit` in batches. `emit` returns `false` once the receiver
/// is gone (the user navigated away), which stops the walk early.
///
/// `readdir` itself is sequential and cheap; per-entry `lstat` is converted in
/// parallel per batch. Finder tags need a `getxattr` per entry, which is ~15x the
/// cost of the listing itself on large folders, so they follow `Done` as
/// `Tags` events carrying only the entries that actually have tags.
pub fn list_dir(dir: &Path, mut emit: impl FnMut(DirEvent) -> bool) -> AppResult<()> {
    let read = fs::read_dir(dir).map_err(|e| AppError::from_io(&e, dir))?;

    let mut pending: Vec<DirEntry> = Vec::with_capacity(FIRST_BATCH);
    let mut limit = FIRST_BATCH;
    let mut total: u32 = 0;
    let mut paths: Vec<PathBuf> = Vec::new();
    for item in read.flatten() {
        paths.push(item.path());
        pending.push(item);
        if pending.len() >= limit {
            if !flush(&mut pending, &mut total, &mut emit) {
                return Err(AppError::Cancelled);
            }
            limit = BATCH;
        }
    }
    if !pending.is_empty() && !flush(&mut pending, &mut total, &mut emit) {
        return Err(AppError::Cancelled);
    }
    if !emit(DirEvent::Done { total }) {
        return Err(AppError::Cancelled);
    }

    // Sequential on purpose: parallel getxattr contends in the kernel and was
    // slower (2.0 s vs 1.4 s for 100k entries) while starving the IPC threads.
    for chunk in paths.chunks(TAG_CHUNK) {
        let tagged: Vec<TaggedPath> = chunk
            .iter()
            .filter_map(|p| {
                let tags = read_tags(p);
                (!tags.is_empty()).then(|| TaggedPath { path: p.to_string_lossy().into_owned(), tags })
            })
            .collect();
        if !tagged.is_empty() && !emit(DirEvent::Tags { entries: tagged }) {
            return Err(AppError::Cancelled);
        }
    }
    Ok(())
}

fn flush(items: &mut Vec<DirEntry>, total: &mut u32, emit: &mut impl FnMut(DirEvent) -> bool) -> bool {
    // A single unreadable entry (racing delete, broken network share) must not
    // abort the whole listing, so failures are dropped.
    let entries: Vec<FileEntry> = items.par_iter().filter_map(to_entry).collect();
    items.clear();
    *total += u32::try_from(entries.len()).unwrap_or(u32::MAX);
    emit(DirEvent::Batch { entries })
}

fn to_entry(item: &DirEntry) -> Option<FileEntry> {
    let path = item.path();
    // DirEntry::metadata does not follow symlinks on unix (lstat semantics).
    let meta = item.metadata().ok()?;
    let name = item.file_name().to_string_lossy().into_owned();
    Some(build_entry(name, &path, &meta, false))
}

/// `with_tags` costs one `getxattr` per entry; listings skip it and stream tags
/// afterwards (see [`list_dir`]), single-entry callers just pass `true`.
pub fn build_entry(name: String, path: &Path, meta: &Metadata, with_tags: bool) -> FileEntry {
    let ft = meta.file_type();
    let extension = path.extension().map(|e| e.to_string_lossy().into_owned());

    let (kind, symlink) = if ft.is_symlink() {
        (EntryKind::Symlink, Some(resolve_symlink(path)))
    } else if ft.is_dir() {
        let is_pkg = is_package_path(path);
        (if is_pkg { EntryKind::Package } else { EntryKind::Dir }, None)
    } else if ft.is_file() {
        (EntryKind::File, None)
    } else {
        (EntryKind::Other, None)
    };

    let is_hidden = name.starts_with('.') || meta.st_flags() & UF_HIDDEN != 0;
    let is_system_junk = is_junk(&name);
    let is_plain_dir = kind == EntryKind::Dir;

    FileEntry {
        size: if is_plain_dir { 0 } else { meta.len() },
        allocated: meta.blocks() * 512,
        modified_ms: to_ms(meta.modified().ok()).unwrap_or(0),
        created_ms: to_ms(meta.created().ok()),
        accessed_ms: to_ms(meta.accessed().ok()),
        mode: meta.mode(),
        uid: meta.uid(),
        gid: meta.gid(),
        inode: meta.ino(),
        is_hidden,
        is_system_junk,
        extension: if is_plain_dir { None } else { extension },
        tags: if with_tags { read_tags(path) } else { Vec::new() },
        kind,
        symlink,
        path: path.to_string_lossy().into_owned(),
        name,
    }
}

fn resolve_symlink(path: &Path) -> SymlinkInfo {
    let target = fs::read_link(path).map(|t| t.to_string_lossy().into_owned()).unwrap_or_default();
    match fs::metadata(path) {
        Ok(m) => SymlinkInfo { target, target_is_dir: m.is_dir(), broken: false },
        Err(_) => SymlinkInfo { target, target_is_dir: false, broken: true },
    }
}

fn is_junk(name: &str) -> bool {
    matches!(
        name,
        ".DS_Store"
            | ".localized"
            | "Icon\r"
            | ".fseventsd"
            | ".Spotlight-V100"
            | ".Trashes"
            | ".TemporaryItems"
            | ".DocumentRevisions-V100"
    ) || name.starts_with("._")
}

fn to_ms(t: Option<SystemTime>) -> Option<i64> {
    let t = t?;
    Some(match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn collect(dir: &Path) -> (Vec<FileEntry>, Vec<usize>, u32) {
        let mut entries = Vec::new();
        let mut sizes = Vec::new();
        let mut done = 0;
        list_dir(dir, |ev| {
            match ev {
                DirEvent::Batch { entries: b } => {
                    sizes.push(b.len());
                    entries.extend(b);
                }
                DirEvent::Done { total } => done = total,
                DirEvent::Tags { .. } => {}
            }
            true
        })
        .unwrap();
        (entries, sizes, done)
    }

    #[test]
    fn classifies_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        fs::write(d.join("a.txt"), "hello").unwrap();
        fs::write(d.join(".hidden"), "").unwrap();
        fs::write(d.join(".DS_Store"), "").unwrap();
        fs::create_dir(d.join("sub.d")).unwrap();
        fs::create_dir(d.join("Thing.app")).unwrap();
        symlink(d.join("sub.d"), d.join("link-dir")).unwrap();
        symlink(d.join("missing"), d.join("broken")).unwrap();

        let (entries, _, total) = collect(d);
        assert_eq!(total, 7);
        let get = |n: &str| entries.iter().find(|e| e.name == n).unwrap();

        let a = get("a.txt");
        assert_eq!(a.kind, EntryKind::File);
        assert_eq!(a.size, 5);
        assert_eq!(a.extension.as_deref(), Some("txt"));
        assert!(!a.is_hidden);

        assert!(get(".hidden").is_hidden);
        assert!(get(".DS_Store").is_system_junk);

        let sub = get("sub.d");
        assert_eq!(sub.kind, EntryKind::Dir);
        assert_eq!(sub.extension, None, "plain dirs never report an extension");

        assert_eq!(get("Thing.app").kind, EntryKind::Package);

        let link = get("link-dir");
        assert_eq!(link.kind, EntryKind::Symlink);
        let info = link.symlink.as_ref().unwrap();
        assert!(info.target_is_dir && !info.broken);

        assert!(get("broken").symlink.as_ref().unwrap().broken);
    }

    #[test]
    fn batches_and_stops_when_receiver_gone() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..2500 {
            fs::write(tmp.path().join(format!("f{i}")), "").unwrap();
        }
        let (_, sizes, total) = collect(tmp.path());
        assert_eq!(total, 2500);
        assert_eq!(sizes, vec![FIRST_BATCH, BATCH, BATCH, 2500 - FIRST_BATCH - 2 * BATCH]);

        let mut calls = 0;
        let res = list_dir(tmp.path(), |_| {
            calls += 1;
            false
        });
        assert!(matches!(res, Err(AppError::Cancelled)));
        assert_eq!(calls, 1);
    }

    #[test]
    fn tags_follow_done() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("plain"), "").unwrap();
        let tagged = tmp.path().join("tagged");
        fs::write(&tagged, "").unwrap();
        let mut plist = Vec::new();
        plist::Value::Array(vec![plist::Value::String("Red\n6".into())])
            .to_writer_binary(&mut plist)
            .unwrap();
        xattr::set(&tagged, "com.apple.metadata:_kMDItemUserTags", &plist).unwrap();

        let mut seq = Vec::new();
        list_dir(tmp.path(), |ev| {
            seq.push(match ev {
                DirEvent::Batch { entries } => {
                    assert!(entries.iter().all(|e| e.tags.is_empty()), "listing itself skips xattrs");
                    "batch".to_owned()
                }
                DirEvent::Done { .. } => "done".to_owned(),
                DirEvent::Tags { entries } => {
                    assert_eq!(entries.len(), 1);
                    assert!(entries[0].path.ends_with("/tagged"));
                    assert_eq!(entries[0].tags[0].color, 6);
                    "tags".to_owned()
                }
            });
            true
        })
        .unwrap();
        assert_eq!(seq, ["batch", "done", "tags"]);
    }

    #[test]
    fn missing_dir_is_not_found() {
        let res = list_dir(Path::new("/definitely/not/here"), |_| true);
        assert!(matches!(res, Err(AppError::NotFound { .. })));
    }
}

#[cfg(test)]
mod bench {
    /// `OX_BENCH_DIR=/path cargo test --release --lib bench_list -- --ignored --nocapture`
    #[test]
    #[ignore = "manual benchmark"]
    fn bench_list() {
        let dir = std::env::var("OX_BENCH_DIR").expect("OX_BENCH_DIR");
        for _ in 0..3 {
            let t = std::time::Instant::now();
            let mut n = 0;
            let mut bytes = 0;
            let mut done_at = None;
            super::list_dir(std::path::Path::new(&dir), |ev| {
                if matches!(ev, crate::model::DirEvent::Done { .. }) {
                    done_at = Some(t.elapsed());
                }
                if let crate::model::DirEvent::Batch { entries } = &ev {
                    n += entries.len();
                    bytes += serde_json::to_vec(&ev).map_or(0, |v| v.len());
                }
                true
            })
            .unwrap();
            eprintln!("listed {n}: done {done_at:?}, with tags {:?} ({} KB json)", t.elapsed(), bytes / 1024);
        }
    }
}
