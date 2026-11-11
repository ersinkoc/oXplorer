//! Archives browsed like folders: `archive:/path/to/file.zip!/inner/folder`.
//! Read-only; members are extracted on demand (to open, Quick Look or copy out).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::SystemTime;

use tauri::{AppHandle, Manager as _};

use crate::error::{AppError, AppResult};
use crate::jobs::archive::{self, Member};
use crate::model::{EntryKind, FileEntry};
use crate::security::validate_path;

pub const PREFIX: &str = "archive:";
const SEP: &str = "!/";

/// `archive:/a/b.zip!/docs` → (`/a/b.zip`, `docs`).
pub fn parse(path: &str) -> AppResult<(PathBuf, String)> {
    let invalid =
        || AppError::InvalidPath { path: path.to_owned(), reason: "not an archive location".into() };
    let rest = path.strip_prefix(PREFIX).ok_or_else(invalid)?;
    // The first `!/` after an archive name: folders may end in `!` too.
    let (archive, inner) = rest
        .match_indices(SEP)
        .map(|(i, _)| (&rest[..i], &rest[i + SEP.len()..]))
        .find(|(a, _)| archive::is_archive(Path::new(a)))
        .unwrap_or((rest.trim_end_matches('!'), ""));
    let archive = validate_path(archive)?;
    if !archive::is_archive(&archive) {
        return Err(invalid());
    }
    let inner = inner.trim_matches('/');
    if inner.split('/').any(|c| c == ".." || c == ".") {
        return Err(invalid());
    }
    Ok((archive, inner.to_owned()))
}

pub fn virtual_path(archive: &Path, inner: &str) -> String {
    format!("{PREFIX}{}{SEP}{inner}", archive.to_string_lossy())
}

type Listing = Arc<Vec<Member>>;

/// A listing with the file's modification time and size when it was read.
type Cached = (SystemTime, u64, Listing);

/// Listings by archive, valid while the file's size and modification time match.
static CACHE: LazyLock<Mutex<HashMap<PathBuf, Cached>>> = LazyLock::new(Default::default);

fn listing(archive: &Path) -> AppResult<Listing> {
    let meta = std::fs::metadata(archive).map_err(|e| AppError::from_io(&e, archive))?;
    let stamp = (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len());
    if let Ok(cache) = CACHE.lock()
        && let Some((t, len, list)) = cache.get(archive)
        && (*t, *len) == stamp
    {
        return Ok(Arc::clone(list));
    }
    let list: Listing = Arc::new(archive::members(archive).map_err(|e| AppError::from_io(&e, archive))?);
    if let Ok(mut cache) = CACHE.lock() {
        // A handful of archives is plenty; drop the rest.
        if cache.len() > 16 {
            cache.clear();
        }
        cache.insert(archive.to_path_buf(), (stamp.0, stamp.1, Arc::clone(&list)));
    }
    Ok(list)
}

fn entry(archive: &Path, inner: &str, name: &str, member: Option<&Member>, is_dir: bool) -> FileEntry {
    let full = if inner.is_empty() { name.to_owned() } else { format!("{inner}/{name}") };
    let kind = if is_dir {
        EntryKind::Dir
    } else if member.is_some_and(|m| m.is_symlink) {
        EntryKind::Symlink
    } else {
        EntryKind::File
    };
    let extension =
        (!is_dir).then(|| Path::new(name).extension().map(|e| e.to_string_lossy().into_owned())).flatten();
    FileEntry {
        name: name.to_owned(),
        path: virtual_path(archive, &full),
        kind,
        symlink: None,
        size: if is_dir { 0 } else { member.map_or(0, |m| m.size) },
        allocated: 0,
        modified_ms: member.map_or(0, |m| m.modified_ms),
        created_ms: None,
        accessed_ms: None,
        mode: if is_dir { 0o755 } else { 0o644 },
        uid: 0,
        gid: 0,
        inode: 0,
        is_hidden: name.starts_with('.'),
        is_system_junk: name == "__MACOSX" || name == ".DS_Store",
        extension,
        tags: Vec::new(),
    }
}

/// The direct children of `inner`, folders implied by deeper paths included.
pub fn list(archive: &Path, inner: &str) -> AppResult<Vec<FileEntry>> {
    let members = listing(archive)?;
    let prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
    // name → (member if listed itself, is a folder)
    let mut children: BTreeMap<String, (Option<&Member>, bool)> = BTreeMap::new();
    for m in members.iter() {
        let Some(rest) = m.path.strip_prefix(&prefix) else { continue };
        if rest.is_empty() {
            continue;
        }
        match rest.split_once('/') {
            Some((dir, _)) => {
                children.entry(dir.to_owned()).or_insert((None, true)).1 = true;
            }
            None => {
                let slot = children.entry(rest.to_owned()).or_insert((None, m.is_dir));
                slot.0 = Some(m);
                slot.1 |= m.is_dir;
            }
        }
    }
    Ok(children.into_iter().map(|(name, (m, is_dir))| entry(archive, inner, &name, m, is_dir)).collect())
}

/// Lists a folder inside an archive.
#[tauri::command]
#[specta::specta]
pub async fn archive_list(path: String) -> AppResult<Vec<FileEntry>> {
    let (archive, inner) = parse(&path)?;
    tauri::async_runtime::spawn_blocking(move || list(&archive, &inner))
        .await
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

/// Extracts one member to a private temporary folder (to open it or Quick Look
/// it) and returns the real path.
#[tauri::command]
#[specta::specta]
pub async fn archive_open_member(app: AppHandle, path: String) -> AppResult<String> {
    let base = app.path().app_cache_dir().map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    tauri::async_runtime::spawn_blocking(move || open_member(&base, path, &mut |_| true))
        .await
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

/// Modified time, size and inode.
type Stamp = (SystemTime, u64, u64);

fn stamp(meta: &std::fs::Metadata) -> Stamp {
    use std::os::unix::fs::MetadataExt as _;
    (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len(), meta.ino())
}

/// A copy of a member: the archive it came from, the copy and how the copy was left.
type Opened = Arc<Mutex<Option<(Stamp, PathBuf, Stamp)>>>;

/// The last copy of each member opened, by virtual path. The preview pane and
/// Quick Look open the same member at once: the second one gets the copy the
/// first made instead of deleting it to extract it again.
static OPENED: LazyLock<Mutex<HashMap<String, Opened>>> = LazyLock::new(Mutex::default);

fn open_member(base: &Path, path: String, tick: &mut dyn FnMut(u64) -> bool) -> AppResult<String> {
    let (archive, inner) = parse(&path)?;
    let slot = OPENED.lock().unwrap_or_else(PoisonError::into_inner).entry(path.clone()).or_default().clone();
    let mut last = slot.lock().unwrap_or_else(PoisonError::into_inner);
    let source = stamp(&std::fs::metadata(&archive).map_err(|e| AppError::from_io(&e, &archive))?);
    // Not when the archive or the copy changed since (an app saved over the copy).
    if let Some((from, copy, left)) = last.as_ref()
        && *from == source
        && copy.symlink_metadata().is_ok_and(|m| stamp(&m) == *left)
    {
        return Ok(copy.to_string_lossy().into_owned());
    }
    let dir = base.join("archive-open").join(format!("{:x}", stable_hash(&path)));
    archive::remove_staging(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| AppError::from_io(&e, &dir))?;
    let created = archive::extract_members(&archive, &[inner], &dir, tick)
        .map_err(|e| AppError::from_io(&e, &archive))?;
    let copy = created.into_iter().next().ok_or(AppError::NotFound { path })?;
    *last = copy.symlink_metadata().ok().map(|m| (source, copy.clone(), stamp(&m)));
    Ok(copy.to_string_lossy().into_owned())
}

fn stable_hash(s: &str) -> u64 {
    // FNV-1a: stable across runs, unlike the std hasher.
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_virtual_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("a b.zip");
        std::fs::write(&zip, "").unwrap();
        let v = virtual_path(&zip, "docs/x");
        assert_eq!(parse(&v).unwrap(), (zip.clone(), "docs/x".to_owned()));
        assert_eq!(parse(&format!("{PREFIX}{}", zip.display())).unwrap().1, "");
        assert!(parse(&virtual_path(&zip, "../etc")).is_err());
        assert!(parse("archive:/tmp/not-an-archive.txt!/x").is_err());
        // A folder whose name ends in `!`.
        let wow = tmp.path().join("Wow!");
        std::fs::create_dir(&wow).unwrap();
        let inside = wow.join("a.zip");
        std::fs::write(&inside, "").unwrap();
        assert_eq!(parse(&virtual_path(&inside, "docs")).unwrap(), (inside, "docs".to_owned()));
        assert!(parse("/plain/path").is_err());
    }

    #[test]
    fn lists_children_with_implied_folders() {
        use std::io::Write as _;
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("t.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        let opts = zip::write::SimpleFileOptions::default();
        // No explicit "docs/" or "docs/deep/" entries.
        z.start_file("docs/deep/x.txt", opts).unwrap();
        z.write_all(b"x").unwrap();
        z.start_file("readme.md", opts).unwrap();
        z.write_all(b"hello").unwrap();
        z.finish().unwrap();

        let root = list(&zip_path, "").unwrap();
        let names: Vec<_> = root.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(names, vec![("docs", EntryKind::Dir), ("readme.md", EntryKind::File)]);
        assert_eq!(root[1].size, 5);
        assert_eq!(root[0].path, virtual_path(&zip_path, "docs"));
        let deep = list(&zip_path, "docs").unwrap();
        assert_eq!(deep.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["deep"]);
    }

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        use std::io::Write as _;
        let mut w = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, data) in files {
            w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(data).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn opening_a_member_again_leaves_the_copy_in_use_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let zip_path = tmp.path().join("box.zip");
        write_zip(&zip_path, &[("notes.txt", b"first"), ("other.txt", b"other")]);
        let cache = tmp.path().join("cache");
        let path = virtual_path(&zip_path, "notes.txt");
        let first = open_member(&cache, path.clone(), &mut |_| true).unwrap();
        // Control: another member opens to its own copy.
        let other = open_member(&cache, virtual_path(&zip_path, "other.txt"), &mut |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(other).unwrap(), "other");

        // Opened again (preview pane and Quick Look at once): while that runs, the
        // copy the first caller got is still there to read.
        let mut during = None;
        let second = open_member(&cache, path.clone(), &mut |_| {
            during.get_or_insert_with(|| std::fs::read_to_string(&first).ok());
            true
        })
        .unwrap();
        println!("EXPECTED: during the second open Some(\"first\") (or not extracted again)");
        println!("ACTUAL:   {during:?}");
        assert!(!matches!(during, Some(None)), "the first copy was removed while the second open ran");
        assert_eq!(second, first);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "first");

        // A changed archive is extracted again.
        write_zip(&zip_path, &[("notes.txt", b"second edition"), ("other.txt", b"other")]);
        let fresh = open_member(&cache, path.clone(), &mut |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "second edition");
        // So is a copy an app saved over.
        std::fs::write(&fresh, "edited in an app, longer").unwrap();
        let again = open_member(&cache, path.clone(), &mut |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&again).unwrap(), "second edition");
        // And a copy that was deleted.
        std::fs::remove_file(&again).unwrap();
        let back = open_member(&cache, path.clone(), &mut |_| true).unwrap();
        assert_eq!(std::fs::read_to_string(&back).unwrap(), "second edition");

        // Two opens at once (gated): the first is held mid-extraction while the
        // second starts; both end with the same, whole copy.
        write_zip(&zip_path, &[("notes.txt", b"third"), ("other.txt", b"other")]);
        let (in_tick, held) = std::sync::mpsc::channel();
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let (a, b) = std::thread::scope(|sc| {
            let a = sc.spawn(|| {
                let mut once = Some((in_tick, wait));
                open_member(&cache, path.clone(), &mut |_| {
                    if let Some((tx, rx)) = once.take() {
                        tx.send(()).unwrap();
                        rx.recv().unwrap();
                    }
                    true
                })
            });
            held.recv().unwrap();
            let b = sc.spawn(|| open_member(&cache, path.clone(), &mut |_| true));
            release.send(()).unwrap();
            (a.join().unwrap().unwrap(), b.join().unwrap().unwrap())
        });
        assert_eq!(a, b);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "third");
    }
}
