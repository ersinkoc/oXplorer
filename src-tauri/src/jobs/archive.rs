//! Compressing to and extracting from zip, tar.gz and tar.zst, with progress
//! and cancellation. Archives are written and unpacked under a hidden temporary
//! name and only renamed into place once complete, so a cancelled or failed job
//! never leaves a half-written archive or folder behind.
//!
//! Extraction never writes outside its staging folder: zip entry names go
//! through `enclosed_name` plus a symlink check on every parent component, and
//! the tar crate validates each entry against the destination itself.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormat {
    Zip,
    TarGz,
    TarZst,
}

impl ArchiveFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Zip => ".zip",
            Self::TarGz => ".tar.gz",
            Self::TarZst => ".tar.zst",
        }
    }
}

/// What an existing file is, judged by its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Zip,
    Tar,
    TarGz,
    TarZst,
}

/// Longest suffixes first, so `.tar.gz` wins over `.gz`.
const SUFFIXES: &[(&str, Kind)] = &[
    (".tar.gz", Kind::TarGz),
    (".tar.zst", Kind::TarZst),
    (".tgz", Kind::TarGz),
    (".tzst", Kind::TarZst),
    (".tar", Kind::Tar),
    (".zip", Kind::Zip),
];

fn kind_of(path: &Path) -> Option<(Kind, &'static str)> {
    let name = path.file_name()?.to_str()?.to_ascii_lowercase();
    SUFFIXES.iter().find(|(s, _)| name.ends_with(s) && name.len() > s.len()).map(|(s, k)| (*k, *s))
}

/// What `compress`/`extract` return when `tick` asked to stop.
fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "cancelled")
}

/// Reports every chunk read; `tick` returning false aborts the read. The error
/// is deliberately *not* `Interrupted`: `io::copy` and the tar reader retry
/// those, which would silently skip data instead of stopping.
struct Progress<'a, R> {
    inner: R,
    tick: &'a mut dyn FnMut(u64) -> bool,
}

impl<R: Read> Read for Progress<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 && !(self.tick)(n as u64) {
            return Err(io::Error::other("cancelled"));
        }
        Ok(n)
    }
}

/// `stem.ext`, then `stem 2.ext`, `stem 3.ext`, … — the first that doesn't exist.
fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let free = |p: &PathBuf| p.symlink_metadata().is_err();
    let first = dir.join(format!("{stem}{ext}"));
    if free(&first) {
        return first;
    }
    (2..).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(free).unwrap_or(first)
}

/// Finder's naming: `name.zip` for one item, `Archive.zip` for several. A name
/// another Compress is still writing (its temp file exists) counts as taken.
pub fn archive_path(sources: &[PathBuf], format: ArchiveFormat) -> Option<PathBuf> {
    let dir = sources.first()?.parent()?;
    let stem = match sources {
        [one] => one.file_name()?.to_string_lossy().into_owned(),
        _ => "Archive".to_owned(),
    };
    let ext = format.extension();
    let free = |p: &PathBuf| p.symlink_metadata().is_err() && part_file(p).symlink_metadata().is_err();
    let first = dir.join(format!("{stem}{ext}"));
    if free(&first) {
        return Some(first);
    }
    (2..).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(free)
}

/// Where `compress` writes before the archive is complete.
fn part_file(dest: &Path) -> PathBuf {
    let name = dest.file_name().map_or_else(|| "archive".into(), |n| n.to_string_lossy().into_owned());
    dest.with_file_name(format!(".{name}.oxpart"))
}

/// The work an extraction reports progress in: uncompressed bytes for zip
/// (known up front), compressed bytes read for tar streams.
pub fn work_units(archive: &Path) -> u64 {
    match kind_of(archive) {
        Some((Kind::Zip, _)) => File::open(archive)
            .ok()
            .and_then(|f| zip::ZipArchive::new(BufReader::new(f)).ok())
            .map_or(0, |mut z| (0..z.len()).filter_map(|i| z.by_index(i).ok().map(|f| f.size())).sum()),
        _ => fs::metadata(archive).map_or(0, |m| m.len()),
    }
}

// ---------------------------------------------------------------------------
// Compress

/// Files and folders under `sources`, with their names inside the archive.
fn collect(sources: &[PathBuf], base: &Path) -> io::Result<Vec<(PathBuf, String, fs::Metadata)>> {
    fn walk(path: &Path, name: String, out: &mut Vec<(PathBuf, String, fs::Metadata)>) -> io::Result<()> {
        let meta = fs::symlink_metadata(path)?;
        let is_dir = meta.is_dir();
        out.push((path.to_path_buf(), name.clone(), meta));
        if is_dir {
            let mut children: Vec<_> =
                fs::read_dir(path)?.filter_map(Result::ok).map(|e| e.file_name()).collect();
            children.sort();
            for child in children {
                // Finder's folder bookkeeping isn't content.
                if child == ".DS_Store" {
                    continue;
                }
                walk(&path.join(&child), format!("{name}/{}", child.to_string_lossy()), out)?;
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    for src in sources {
        let rel = src.strip_prefix(base).unwrap_or(src);
        walk(src, rel.to_string_lossy().into_owned(), &mut out)?;
    }
    Ok(out)
}

/// Local wall-clock time of a file, as zip stores it.
fn zip_time(meta: &fs::Metadata) -> Option<zip::DateTime> {
    let secs: libc::time_t = meta.mtime();
    // SAFETY: localtime_r only writes the provided struct.
    let tm = unsafe {
        let mut tm = std::mem::zeroed::<libc::tm>();
        if libc::localtime_r(&secs, &mut tm).is_null() {
            return None;
        }
        tm
    };
    zip::DateTime::from_date_and_time(
        u16::try_from(tm.tm_year + 1900).ok()?,
        u8::try_from(tm.tm_mon + 1).ok()?,
        u8::try_from(tm.tm_mday).ok()?,
        u8::try_from(tm.tm_hour).ok()?,
        u8::try_from(tm.tm_min).ok()?,
        u8::try_from(tm.tm_sec).ok()?,
    )
    .ok()
}

fn write_zip(
    items: &[(PathBuf, String, fs::Metadata)],
    out: File,
    password: Option<&str>,
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<()> {
    use zip::write::SimpleFileOptions;
    let mut zip = zip::ZipWriter::new(BufWriter::new(out));
    let base = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (path, name, meta) in items {
        let mut opts = base.unix_permissions(meta.mode() & 0o777);
        if let Some(t) = zip_time(meta) {
            opts = opts.last_modified_time(t);
        }
        let ft = meta.file_type();
        if ft.is_symlink() {
            let target = fs::read_link(path)?;
            zip.add_symlink(name, target.to_string_lossy(), opts).map_err(io::Error::other)?;
        } else if ft.is_dir() {
            zip.add_directory(format!("{name}/"), opts).map_err(io::Error::other)?;
        } else if ft.is_file() {
            let opts = opts.large_file(meta.len() >= u64::from(u32::MAX));
            // AES-256 (WinZip AE-2): OXplorer, 7-Zip, Keka, The Unarchiver and bsdtar open it;
            // Finder's Archive Utility and `unzip` can't.
            let opts = match password {
                Some(pw) => opts.with_aes_encryption(zip::AesMode::Aes256, pw),
                None => opts,
            };
            zip.start_file(name, opts).map_err(io::Error::other)?;
            io::copy(&mut Progress { inner: File::open(path)?, tick: &mut *tick }, &mut zip)?;
        }
    }
    zip.finish().map_err(io::Error::other)?.flush()
}

fn write_tar<W: Write>(
    items: &[(PathBuf, String, fs::Metadata)],
    out: W,
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<W> {
    let mut tar = tar::Builder::new(out);
    tar.follow_symlinks(false);
    for (path, name, meta) in items {
        let ft = meta.file_type();
        let mut header = tar::Header::new_gnu();
        header.set_metadata(meta);
        if ft.is_symlink() {
            header.set_size(0);
            tar.append_link(&mut header, name, fs::read_link(path)?)?;
        } else if ft.is_dir() {
            tar.append_dir(name, path)?;
        } else if ft.is_file() {
            tar.append_data(&mut header, name, Progress { inner: File::open(path)?, tick: &mut *tick })?;
        }
    }
    tar.into_inner()
}

/// Writes `sources` (siblings in one folder) into the archive `dest`.
/// `password` encrypts a zip; other formats have no encryption.
pub fn compress(
    sources: &[PathBuf],
    dest: &Path,
    format: ArchiveFormat,
    password: Option<&str>,
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<()> {
    let base = sources.first().and_then(|s| s.parent()).unwrap_or(Path::new("/"));
    let items = collect(sources, base)?;
    let temp = part_file(dest);
    let mut stopped = false;
    let tick = &mut |n: u64| {
        let go = tick(n);
        stopped |= !go;
        go
    };
    // Another job may be writing the same temp file: only its creator removes it.
    let out = File::create_new(&temp)?;
    let result = (|| {
        match format {
            ArchiveFormat::Zip => write_zip(&items, out, password, tick)?,
            ArchiveFormat::TarGz => {
                let gz = flate2::write::GzEncoder::new(BufWriter::new(out), flate2::Compression::default());
                write_tar(&items, gz, tick)?.finish()?.flush()?;
            }
            ArchiveFormat::TarZst => {
                let zst = zstd::Encoder::new(BufWriter::new(out), 3)?;
                write_tar(&items, zst, tick)?.finish()?.flush()?;
            }
        }
        // Never over an item that appeared at `dest` in the meantime.
        super::fsops::rename_excl(&temp, dest)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    if stopped { Err(cancelled()) } else { result }
}

// ---------------------------------------------------------------------------
// Extract

/// `root/rel`, refusing to pass through a symlink (a crafted archive could
/// first create `a -> /etc` and then write `a/passwd`).
fn safe_join(root: &Path, rel: &Path) -> io::Result<PathBuf> {
    let mut out = root.to_path_buf();
    let mut parts = rel.components().peekable();
    while let Some(c) = parts.next() {
        let Component::Normal(part) = c else {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "unsafe path in archive"));
        };
        out.push(part);
        if parts.peek().is_some() && out.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "archive entry goes through a symlink"));
        }
    }
    Ok(out)
}

/// The longest link target a member may have (macOS PATH_MAX).
const LINK_MAX: u64 = 1024;

/// Maps a member's path inside the archive to where it goes under the staging
/// folder; `None` skips it.
type Select<'a> = &'a dyn Fn(&Path) -> Option<PathBuf>;

fn unzip(
    archive: &Path,
    staging: &Path,
    password: Option<&str>,
    tick: &mut dyn FnMut(u64) -> bool,
    select: Select,
) -> io::Result<()> {
    let mut zip = zip::ZipArchive::new(BufReader::new(File::open(archive)?)).map_err(io::Error::other)?;
    for i in 0..zip.len() {
        let entry = match password {
            Some(pw) => zip.by_index_decrypt(i, pw.as_bytes()),
            None => zip.by_index(i),
        };
        let mut entry = entry.map_err(zip_error)?;
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "unsafe path in archive"))?;
        // Resource forks and Finder metadata from Archive Utility.
        if rel.starts_with("__MACOSX") || rel.file_name().is_some_and(|n| n == ".DS_Store") {
            continue;
        }
        let Some(rel) = select(&rel) else { continue };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = safe_join(staging, &rel)?;
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        if entry.is_symlink() {
            // A link's target is a path (at most PATH_MAX bytes): never read more,
            // a crafted entry can unpack to gigabytes.
            let mut target = String::new();
            Read::by_ref(&mut entry).take(LINK_MAX + 1).read_to_string(&mut target)?;
            if target.len() as u64 > LINK_MAX {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "a link in the archive is too long"));
            }
            std::os::unix::fs::symlink(target, &out)?;
            continue;
        }
        let mut file = File::create_new(&out)?;
        io::copy(&mut Progress { inner: &mut entry, tick: &mut *tick }, &mut file)?;
        // Permission bits only: never setuid/setgid from an archive.
        if let Some(mode) = entry.unix_mode() {
            file.set_permissions(fs::Permissions::from_mode((mode & 0o777) | 0o200))?;
        }
        if let Some(t) = entry.last_modified().and_then(zip_to_system_time) {
            let _ = file.set_modified(t);
        }
    }
    Ok(())
}

/// A wrong or missing password reads as such, not as a generic zip error.
fn zip_error(e: zip::result::ZipError) -> io::Error {
    match e {
        zip::result::ZipError::InvalidPassword => {
            // Not PermissionDenied: that reads as a file-permission (or Full Disk Access) problem.
            io::Error::new(io::ErrorKind::InvalidInput, "the password is wrong")
        }
        zip::result::ZipError::UnsupportedArchive(m) if m.contains("assword") => {
            io::Error::new(io::ErrorKind::InvalidInput, "the archive needs a password")
        }
        other => io::Error::other(other),
    }
}

/// Passwords of zips opened like folders this session, by archive path. Memory
/// only: never written anywhere, gone when OXplorer quits.
static PASSWORDS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<PathBuf, String>>> =
    std::sync::LazyLock::new(Default::default);

fn known_password(archive: &Path) -> Option<String> {
    PASSWORDS.lock().ok()?.get(archive).cloned()
}

/// Checks `password` against the first encrypted member and, if it opens it,
/// remembers it for reading members of `archive` (copying out, opening, Quick Look).
pub fn unlock(archive: &Path, password: &str) -> io::Result<()> {
    let mut zip = zip::ZipArchive::new(BufReader::new(File::open(archive)?)).map_err(io::Error::other)?;
    let first = (0..zip.len())
        .find(|&i| zip.by_index_raw(i).is_ok_and(|e| e.encrypted() && !e.is_dir()))
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the archive isn’t encrypted"))?;
    let mut entry = zip.by_index_decrypt(first, password.as_bytes()).map_err(zip_error)?;
    // Opening checks the password's verifier; reading a little catches the rare false match.
    let mut buf = [0u8; 4096];
    let _ = entry
        .read(&mut buf)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "the password is wrong"))?;
    drop(entry);
    if let Ok(mut map) = PASSWORDS.lock() {
        map.insert(archive.to_path_buf(), password.to_owned());
    }
    Ok(())
}

/// Whether a zip has encrypted members (Extract asks for the password first).
pub fn zip_encrypted(archive: &Path) -> io::Result<bool> {
    if !matches!(kind_of(archive), Some((Kind::Zip, _))) {
        return Ok(false);
    }
    let mut zip = zip::ZipArchive::new(BufReader::new(File::open(archive)?)).map_err(io::Error::other)?;
    for i in 0..zip.len() {
        if zip.by_index_raw(i).map_err(io::Error::other)?.encrypted() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn zip_to_system_time(t: zip::DateTime) -> Option<SystemTime> {
    // SAFETY: mktime reads and normalizes the struct it's given.
    let secs = unsafe {
        let mut tm = std::mem::zeroed::<libc::tm>();
        tm.tm_year = i32::from(t.year()) - 1900;
        tm.tm_mon = i32::from(t.month()) - 1;
        tm.tm_mday = i32::from(t.day());
        tm.tm_hour = i32::from(t.hour());
        tm.tm_min = i32::from(t.minute());
        tm.tm_sec = i32::from(t.second());
        tm.tm_isdst = -1;
        libc::mktime(&mut tm)
    };
    u64::try_from(secs).ok().map(|s| UNIX_EPOCH + Duration::from_secs(s))
}

/// Folder modes from a tar that still have to be applied, by name of a folder
/// right inside the staging folder (the caller moves those out first: a
/// read-only folder can't be moved to another parent).
type TopModes = Vec<(std::ffi::OsString, u32)>;

/// Hard links picked without what they point at: (target member, where the
/// link goes). A second pass over the tar writes the target's content there.
type Links = Vec<(PathBuf, PathBuf)>;

/// AppleDouble files (`._name`) that macOS tar adds for extended attributes;
/// bsdtar folds them back into the file, other tools show them as junk.
fn is_apple_double(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.as_encoded_bytes().starts_with(b"._"))
}

/// Folders are written owner-writable and get their real mode once their
/// contents are in, so read-only folders in an archive still extract.
fn untar<R: Read>(reader: R, staging: &Path, select: Option<Select>) -> io::Result<(TopModes, Links)> {
    let mut tar = tar::Archive::new(reader);
    tar.set_preserve_permissions(true);
    tar.set_preserve_mtime(true);
    tar.set_unpack_xattrs(false);
    tar.set_overwrite(false);
    let mut dirs: Vec<(PathBuf, u32)> = Vec::new();
    let mut links = Links::new();
    for entry in tar.entries()? {
        let mut entry = entry?;
        if is_apple_double(&entry.path()?) {
            continue;
        }
        entry.set_mask(0o7000);
        let is_dir = entry.header().entry_type().is_dir();
        let mode = entry.header().mode().unwrap_or(0o755) & 0o777;
        let out = match select {
            None => {
                let out = staging.join(normalize_member(&entry.path()?)?);
                if !entry.unpack_in(staging)? {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "unsafe path in archive"));
                }
                out
            }
            Some(select) => {
                let path = entry.path()?.into_owned();
                let Some(rel) = select(&normalize_member(&path)?) else { continue };
                if rel.as_os_str().is_empty() {
                    continue;
                }
                let out = safe_join(staging, &rel)?;
                if let Some(parent) = out.parent() {
                    fs::create_dir_all(parent)?;
                }
                if entry.header().entry_type().is_hard_link() {
                    // Picked together with its target: link to the copy made
                    // already (targets come first in a tar); otherwise later.
                    let Some(target) = entry.link_name()? else { continue };
                    let target = normalize_member(&target)?;
                    let made = select(&target)
                        .filter(|t| !t.as_os_str().is_empty())
                        .map(|t| safe_join(staging, &t))
                        .transpose()?
                        .filter(|t| t.symlink_metadata().is_ok_and(|m| m.is_file()));
                    match made {
                        Some(t) => fs::hard_link(t, &out)?,
                        None => links.push((target, out)),
                    }
                    continue;
                }
                entry.unpack(&out)?;
                out
            }
        };
        if is_dir && out.is_dir() {
            fs::set_permissions(&out, fs::Permissions::from_mode(mode | 0o700))?;
            dirs.push((out, mode));
        }
    }
    // Deepest first, so a parent is locked only after its children are done.
    dirs.sort_by_key(|(p, _)| std::cmp::Reverse(p.components().count()));
    let mut top = TopModes::new();
    for (p, mode) in dirs {
        match (p.parent() == Some(staging), p.file_name()) {
            (true, Some(name)) => top.push((name.to_owned(), mode)),
            _ => fs::set_permissions(&p, fs::Permissions::from_mode(mode))?,
        }
    }
    Ok((top, links))
}

/// Writes the content of each hard link's target member to where the link goes.
fn fill_links<R: Read>(reader: R, links: &Links) -> io::Result<()> {
    let mut tar = tar::Archive::new(reader);
    for entry in tar.entries()? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = normalize_member(&entry.path()?)?;
        let mut outs = links.iter().filter(|(t, _)| *t == path).map(|(_, o)| o);
        let Some(first) = outs.next() else { continue };
        entry.set_mask(0o7000);
        entry.unpack(first)?;
        for o in outs {
            fs::hard_link(first, o)?;
        }
    }
    match links.iter().find(|(_, o)| o.symlink_metadata().is_err()) {
        Some((t, _)) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a hard link in the archive points at a missing member: {}", t.display()),
        )),
        None => Ok(()),
    }
}

/// Removes a failed extraction, read-only folders included.
fn remove_staging(staging: &Path) {
    fn unlock(dir: &Path) {
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                unlock(&e.path());
            }
        }
    }
    unlock(staging);
    let _ = fs::remove_dir_all(staging);
}

/// Applies the modes `untar` left for later, once each folder is at `place(name)`.
fn apply_top_modes(top: &TopModes, place: impl Fn(&std::ffi::OsStr) -> Option<PathBuf>) {
    for (name, mode) in top {
        if let Some(p) = place(name) {
            let _ = fs::set_permissions(p, fs::Permissions::from_mode(*mode));
        }
    }
}

/// A member path without `./`, refusing `..` and absolute paths.
fn normalize_member(path: &Path) -> io::Result<PathBuf> {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "unsafe path in archive")),
        }
    }
    Ok(out)
}

/// Extracts next to the archive (tests use this; jobs pick the folder).
#[cfg(test)]
pub fn extract(
    archive: &Path,
    password: Option<&str>,
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<PathBuf> {
    extract_to(archive, archive.parent().unwrap_or(Path::new("/")), password, tick)
}

/// Extracts into `dir` like Archive Utility: a single top-level item lands as
/// itself, anything else in a folder named after the archive.
pub fn extract_to(
    archive: &Path,
    dir: &Path,
    password: Option<&str>,
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<PathBuf> {
    let (kind, suffix) = kind_of(archive)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a supported archive"))?;
    let name = archive.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let stem = &name[..name.len() - suffix.len()];
    let staging = unique(dir, &format!(".{stem}.oxextract"), "");
    fs::create_dir(&staging)?;
    let mut stopped = false;
    let tick = &mut |n: u64| {
        let go = tick(n);
        stopped |= !go;
        go
    };

    let result = (|| {
        let top = match kind {
            Kind::Zip => {
                unzip(archive, &staging, password, tick, &|p| Some(p.to_path_buf()))?;
                TopModes::new()
            }
            _ => {
                let raw = Progress { inner: BufReader::new(File::open(archive)?), tick: &mut *tick };
                match kind {
                    Kind::Tar => untar(raw, &staging, None)?.0,
                    Kind::TarGz => untar(flate2::read::GzDecoder::new(raw), &staging, None)?.0,
                    _ => untar(zstd::Decoder::new(raw)?, &staging, None)?.0,
                }
            }
        };
        let children: Vec<PathBuf> =
            fs::read_dir(&staging)?.filter_map(Result::ok).map(|e| e.path()).collect();
        if let [only] = children.as_slice() {
            let only_name = only.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            let target = unique(dir, &only_name, "");
            fs::rename(only, &target)?;
            fs::remove_dir(&staging)?;
            apply_top_modes(&top, |_| Some(target.clone()));
            Ok(target)
        } else {
            let target = unique(dir, stem, "");
            fs::rename(&staging, &target)?;
            apply_top_modes(&top, |name| Some(target.join(name)));
            Ok(target)
        }
    })();
    if result.is_err() {
        remove_staging(&staging);
    }
    if stopped { Err(cancelled()) } else { result }
}

// ---------------------------------------------------------------------------
// Browsing: listing members and extracting some of them

/// One file, folder or link inside an archive.
#[derive(Debug, Clone)]
pub struct Member {
    /// Path inside the archive, `/`-separated, without a trailing slash.
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified_ms: i64,
}

pub fn is_archive(path: &Path) -> bool {
    kind_of(path).is_some()
}

fn tar_members<R: Read>(reader: R) -> io::Result<Vec<Member>> {
    let mut tar = tar::Archive::new(reader);
    let mut out = Vec::new();
    for entry in tar.entries()? {
        let entry = entry?;
        let header = entry.header();
        let path = normalize_member(&entry.path()?)?;
        if is_apple_double(&path) {
            continue;
        }
        let ty = header.entry_type();
        out.push(Member {
            path: path.to_string_lossy().into_owned(),
            is_dir: ty.is_dir(),
            is_symlink: ty.is_symlink(),
            size: header.size().unwrap_or(0),
            modified_ms: header.mtime().map_or(0, |s| i64::try_from(s).unwrap_or(0) * 1000),
        });
    }
    Ok(out)
}

/// Everything in the archive (read from the zip directory, or by streaming the tar).
pub fn members(archive: &Path) -> io::Result<Vec<Member>> {
    let (kind, _) = kind_of(archive)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a supported archive"))?;
    let raw = BufReader::new(File::open(archive)?);
    match kind {
        Kind::Zip => {
            let mut zip = zip::ZipArchive::new(raw).map_err(io::Error::other)?;
            let mut out = Vec::with_capacity(zip.len());
            for i in 0..zip.len() {
                let entry = zip.by_index_raw(i).map_err(io::Error::other)?;
                let Some(path) = entry.enclosed_name() else { continue };
                out.push(Member {
                    path: path.to_string_lossy().trim_end_matches('/').to_owned(),
                    is_dir: entry.is_dir(),
                    is_symlink: entry.is_symlink(),
                    size: entry.size(),
                    modified_ms: entry
                        .last_modified()
                        .and_then(zip_to_system_time)
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0)),
                });
            }
            Ok(out)
        }
        Kind::Tar => tar_members(raw),
        Kind::TarGz => tar_members(flate2::read::GzDecoder::new(raw)),
        Kind::TarZst => tar_members(zstd::Decoder::new(raw)?),
    }
}

/// Extracts the members `inners` (folders with everything inside) into `dest`,
/// each as its own item, renamed "name 2" if taken. Returns what was created.
pub fn extract_members(
    archive: &Path,
    inners: &[String],
    dest: &Path,
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<Vec<PathBuf>> {
    let (kind, _) = kind_of(archive)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a supported archive"))?;
    let wanted: Vec<(PathBuf, PathBuf)> = inners
        .iter()
        .map(|i| {
            let p = normalize_member(Path::new(i.trim_matches('/')))?;
            let base = p.parent().map(Path::to_path_buf).unwrap_or_default();
            Ok((p, base))
        })
        .collect::<io::Result<_>>()?;
    let select = |rel: &Path| {
        wanted
            .iter()
            .find(|(p, _)| rel == p || rel.starts_with(p))
            .and_then(|(_, base)| rel.strip_prefix(base).ok().map(Path::to_path_buf))
    };
    let staging = unique(dest, ".oxextract", "");
    fs::create_dir(&staging)?;
    let mut stopped = false;
    let tick = &mut |n: u64| {
        let go = tick(n);
        stopped |= !go;
        go
    };
    let result = (|| {
        let top = match kind {
            Kind::Zip => {
                unzip(archive, &staging, known_password(archive).as_deref(), tick, &select)?;
                TopModes::new()
            }
            _ => {
                let raw = Progress { inner: BufReader::new(File::open(archive)?), tick: &mut *tick };
                let (top, links) = match kind {
                    Kind::Tar => untar(raw, &staging, Some(&select))?,
                    Kind::TarGz => untar(flate2::read::GzDecoder::new(raw), &staging, Some(&select))?,
                    _ => untar(zstd::Decoder::new(raw)?, &staging, Some(&select))?,
                };
                if !links.is_empty() {
                    let raw = BufReader::new(File::open(archive)?);
                    match kind {
                        Kind::Tar => fill_links(raw, &links)?,
                        Kind::TarGz => fill_links(flate2::read::GzDecoder::new(raw), &links)?,
                        _ => fill_links(zstd::Decoder::new(raw)?, &links)?,
                    }
                }
                top
            }
        };
        let mut created = Vec::new();
        for child in fs::read_dir(&staging)?.filter_map(Result::ok) {
            let name = child.file_name();
            let target = unique(dest, &name.to_string_lossy(), "");
            fs::rename(child.path(), &target)?;
            apply_top_modes(&top, |n| (n == name).then(|| target.clone()));
            created.push(target);
        }
        fs::remove_dir(&staging)?;
        Ok(created)
    })();
    if result.is_err() {
        remove_staging(&staging);
    }
    if stopped { Err(cancelled()) } else { result }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tar with a read-only folder (0555) that holds a file.
    #[test]
    fn extracts_read_only_folders_from_a_tar() {
        let tmp = tempfile::tempdir().unwrap();
        let tar_path = tmp.path().join("pkg.tar");
        {
            let mut b = tar::Builder::new(File::create(&tar_path).unwrap());
            for (path, mode) in [("pkg/", 0o755), ("pkg/ro/", 0o555)] {
                let mut h = tar::Header::new_gnu();
                h.set_entry_type(tar::EntryType::Directory);
                h.set_mode(mode);
                h.set_size(0);
                b.append_data(&mut h, path, std::io::empty()).unwrap();
            }
            let mut h = tar::Header::new_gnu();
            h.set_mode(0o644);
            h.set_size(2);
            b.append_data(&mut h, "pkg/ro/f.txt", &b"hi"[..]).unwrap();
            let mut h = tar::Header::new_gnu();
            h.set_entry_type(tar::EntryType::Directory);
            h.set_mode(0o500);
            h.set_size(0);
            b.append_data(&mut h, "top/", std::io::empty()).unwrap();
            b.finish().unwrap();
        }
        let out = extract(&tar_path, None, &mut |_| true).unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(fs::read(out.join("pkg/ro/f.txt")).unwrap(), b"hi");
        assert_eq!(mode(&out.join("pkg/ro")), 0o555);
        assert_eq!(mode(&out.join("top")), 0o500, "a top-level folder gets its mode after the move");

        let dest = tmp.path().join("picked");
        fs::create_dir(&dest).unwrap();
        let picked = extract_members(&tar_path, &["pkg".into()], &dest, &mut |_| true).unwrap();
        assert_eq!(fs::read(picked[0].join("ro/f.txt")).unwrap(), b"hi");
        assert_eq!(mode(&picked[0].join("ro")), 0o555);
        for p in [out.join("pkg/ro"), out.join("top"), picked[0].join("ro")] {
            fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn peak_rss() -> i64 {
        // SAFETY: getrusage fills the struct it's given.
        let mut u = unsafe { std::mem::zeroed::<libc::rusage>() };
        unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
        u.ru_maxrss // bytes on macOS
    }

    /// A zip whose entry `name` holds `len` deflated bytes and is marked as a symlink.
    fn zip_with_link(path: &Path, name: &str, len: usize) {
        let mut w = zip::ZipWriter::new(File::create(path).unwrap());
        w.start_file(name, zip::write::SimpleFileOptions::default()).unwrap();
        let chunk = vec![b'a'; 1 << 20];
        let mut left = len;
        while left > 0 {
            let n = left.min(chunk.len());
            w.write_all(&chunk[..n]).unwrap();
            left -= n;
        }
        w.finish().unwrap();
        // Central directory: made by Unix, external attributes = symlink.
        let mut bytes = fs::read(path).unwrap();
        let at = bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap();
        bytes[at + 5] = 3;
        bytes[at + 38..at + 42].copy_from_slice(&(0o120_777u32 << 16).to_le_bytes());
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_huge_link_in_a_zip_is_refused_without_reading_it() {
        let tmp = tempfile::tempdir().unwrap();
        // Control: an ordinary link extracts.
        let small = tmp.path().join("small.zip");
        zip_with_link(&small, "ok", 5);
        let out = extract(&small, None, &mut |_| true).unwrap();
        assert_eq!(fs::read_link(out).unwrap(), Path::new("aaaaa"));

        let bomb = tmp.path().join("bomb.zip");
        zip_with_link(&bomb, "link", 256 << 20);
        assert!(fs::metadata(&bomb).unwrap().len() < 2 << 20);
        let before = peak_rss();
        let dest = tmp.path().join("picked");
        fs::create_dir(&dest).unwrap();
        let r = extract_members(&bomb, &["link".into()], &dest, &mut |_| true);
        let grew = (peak_rss() - before) >> 20;
        // Other tests share the process: a loose bound (the whole link was 256 MiB+).
        assert!(grew < 128, "reading one link took {grew} MiB");
        assert!(r.is_err_and(|e| e.to_string().contains("too long")));
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);

        // Just past the limit, through a full extraction: refused, nothing left.
        let long = tmp.path().join("long.zip");
        zip_with_link(&long, "far", LINK_MAX as usize + 1);
        assert!(extract(&long, None, &mut |_| true).is_err());
        let left: Vec<_> = fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert!(!left.iter().any(|n| n.to_string_lossy().contains("oxextract") || n == "far"), "{left:?}");
    }

    #[test]
    fn compressing_the_same_item_twice_at_once_makes_two_archives() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tree(tmp.path());
        let one = archive_path(std::slice::from_ref(&src), ArchiveFormat::Zip).unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let first = {
            let (src, one) = (src.clone(), one.clone());
            std::thread::spawn(move || {
                let mut once = Some((started_tx, go_rx));
                compress(&[src], &one, ArchiveFormat::Zip, None, &mut |_| {
                    // Hold the first job mid-write until the second one is done.
                    if let Some((tx, rx)) = once.take() {
                        tx.send(()).unwrap();
                        rx.recv().unwrap();
                    }
                    true
                })
            })
        };
        started_rx.recv().unwrap();
        let two = archive_path(std::slice::from_ref(&src), ArchiveFormat::Zip).unwrap();
        let second = compress(std::slice::from_ref(&src), &two, ArchiveFormat::Zip, None, &mut |_| true);
        go_tx.send(()).unwrap();
        let first = first.join().unwrap();
        assert!(first.is_ok() && second.is_ok(), "first: {first:?}, second: {second:?}");
        assert_ne!(one, two);
        for z in [&one, &two] {
            assert!(zip::ZipArchive::new(File::open(z).unwrap()).unwrap().len() > 2, "{z:?}");
        }

        // Both pick one name (before either started): the second fails, the
        // first's temp file stays and it finishes.
        fs::remove_file(&two).unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let first = {
            let (src, two) = (src.clone(), two.clone());
            std::thread::spawn(move || {
                let mut once = Some((started_tx, go_rx));
                compress(&[src], &two, ArchiveFormat::Zip, None, &mut |_| {
                    if let Some((tx, rx)) = once.take() {
                        tx.send(()).unwrap();
                        rx.recv().unwrap();
                    }
                    true
                })
            })
        };
        started_rx.recv().unwrap();
        let clash = compress(std::slice::from_ref(&src), &two, ArchiveFormat::Zip, None, &mut |_| false);
        assert!(clash.is_err());
        assert!(part_file(&two).exists(), "the running job's temp file was removed");
        // An item made at the name meanwhile is never replaced.
        fs::write(&two, "made meanwhile").unwrap();
        go_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().map_err(|e| e.kind()), Err(io::ErrorKind::AlreadyExists));
        assert_eq!(fs::read(&two).unwrap(), b"made meanwhile");
        assert!(!part_file(&two).exists());
    }

    /// `pkg/a` and its hard link `pkg/b`, as /usr/bin/tar writes them.
    fn tar_with_hard_link(path: &Path) {
        let mut b = tar::Builder::new(File::create(path).unwrap());
        let mut h = tar::Header::new_ustar();
        h.set_entry_type(tar::EntryType::Directory);
        h.set_mode(0o755);
        h.set_size(0);
        b.append_data(&mut h, "pkg/", std::io::empty()).unwrap();
        let mut h = tar::Header::new_ustar();
        h.set_mode(0o644);
        h.set_size(6);
        b.append_data(&mut h, "pkg/a", &b"hello\n"[..]).unwrap();
        let mut h = tar::Header::new_ustar();
        h.set_entry_type(tar::EntryType::Link);
        h.set_mode(0o644);
        h.set_size(0);
        b.append_link(&mut h, "pkg/b", "pkg/a").unwrap();
        b.finish().unwrap();
    }

    #[test]
    fn hard_links_in_a_tar_are_copied_out_too() {
        let tmp = tempfile::tempdir().unwrap();
        let tar_path = tmp.path().join("pkg.tar");
        tar_with_hard_link(&tar_path);
        // Control: a full extraction has both.
        let out = extract(&tar_path, None, &mut |_| true).unwrap();
        assert_eq!(fs::read(out.join("b")).unwrap(), b"hello\n");

        let dest = tmp.path().join("picked");
        fs::create_dir(&dest).unwrap();
        let got = extract_members(&tar_path, &["pkg".into()], &dest, &mut |_| true).unwrap();
        assert_eq!(fs::read(got[0].join("a")).unwrap(), b"hello\n");
        assert_eq!(fs::read(got[0].join("b")).map_err(|e| e.kind()), Ok(b"hello\n".to_vec()), "pkg/b");
        // Only the link, without what it points at.
        let got = extract_members(&tar_path, &["pkg/b".into()], &dest, &mut |_| true).unwrap();
        assert_eq!(got, [dest.join("b")]);
        assert_eq!(fs::read(dest.join("b")).unwrap(), b"hello\n");
        // Picked together: one file, two names.
        let picked = dest.join("pkg");
        assert_eq!(
            fs::metadata(picked.join("a")).unwrap().ino(),
            fs::metadata(picked.join("b")).unwrap().ino()
        );

        // Compressed tars too.
        let gz = tmp.path().join("pkg.tar.gz");
        let mut enc = flate2::write::GzEncoder::new(File::create(&gz).unwrap(), flate2::Compression::fast());
        io::copy(&mut File::open(&tar_path).unwrap(), &mut enc).unwrap();
        enc.finish().unwrap();
        let got = extract_members(&gz, &["pkg/b".into()], &dest, &mut |_| true).unwrap();
        assert_eq!(fs::read(&got[0]).unwrap(), b"hello\n");

        // A link to a member that isn't there: an error, nothing left behind.
        let broken = tmp.path().join("broken.tar");
        {
            let mut b = tar::Builder::new(File::create(&broken).unwrap());
            let mut h = tar::Header::new_ustar();
            h.set_entry_type(tar::EntryType::Link);
            h.set_size(0);
            b.append_link(&mut h, "x", "nowhere").unwrap();
            b.finish().unwrap();
        }
        let empty = tmp.path().join("empty");
        fs::create_dir(&empty).unwrap();
        assert!(extract_members(&broken, &["x".into()], &empty, &mut |_| true).is_err());
        assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
    }

    #[test]
    fn mac_tar_metadata_files_are_left_out() {
        let tmp = tempfile::tempdir().unwrap();
        let tar_path = tmp.path().join("notes.tar");
        {
            let mut b = tar::Builder::new(File::create(&tar_path).unwrap());
            for (name, data) in [("._notes.txt", &b"\x00\x05\x16\x07meta"[..]), ("notes.txt", &b"text"[..])] {
                let mut h = tar::Header::new_ustar();
                h.set_mode(0o644);
                h.set_size(data.len() as u64);
                b.append_data(&mut h, name, data).unwrap();
            }
            b.finish().unwrap();
        }
        let names = |m: Vec<Member>| m.into_iter().map(|m| m.path).collect::<Vec<_>>();
        assert_eq!(names(members(&tar_path).unwrap()), ["notes.txt"]);
        // A single file lands as itself, not in a "notes" folder.
        let out = extract(&tar_path, None, &mut |_| true).unwrap();
        assert_eq!(out, tmp.path().join("notes.txt"));
        assert_eq!(fs::read(&out).unwrap(), b"text");
        assert!(!tmp.path().join("._notes.txt").exists());

        // A folder with its own and its files' metadata: lands as the folder alone.
        let pkg = tmp.path().join("pkg.tar");
        {
            let mut b = tar::Builder::new(File::create(&pkg).unwrap());
            for (name, data) in [
                ("._pkg", &b"\x00\x05\x16\x07"[..]),
                ("pkg/._a", &b"\x00\x05\x16\x07"[..]),
                ("pkg/a", &b"A"[..]),
            ] {
                let mut h = tar::Header::new_ustar();
                h.set_mode(0o644);
                h.set_size(data.len() as u64);
                b.append_data(&mut h, name, data).unwrap();
            }
            b.finish().unwrap();
        }
        let out = extract(&pkg, None, &mut |_| true).unwrap();
        assert_eq!(out, tmp.path().join("pkg"));
        let inside: Vec<_> = fs::read_dir(&out).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(inside, ["a"]);
        let dest = tmp.path().join("picked");
        fs::create_dir(&dest).unwrap();
        extract_members(&pkg, &["pkg".into()], &dest, &mut |_| true).unwrap();
        assert!(!dest.join("pkg/._a").exists());
    }

    fn tree(root: &Path) -> PathBuf {
        let src = root.join("project");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), "alpha").unwrap();
        fs::write(src.join("sub/b.bin"), vec![7u8; 300_000]).unwrap();
        fs::write(src.join(".DS_Store"), "junk").unwrap();
        fs::set_permissions(src.join("a.txt"), fs::Permissions::from_mode(0o750)).unwrap();
        std::os::unix::fs::symlink("a.txt", src.join("link")).unwrap();
        src
    }

    fn round_trip(format: ArchiveFormat) {
        let tmp = tempfile::tempdir().unwrap();
        let src = tree(tmp.path());
        let dest = archive_path(std::slice::from_ref(&src), format).unwrap();
        assert_eq!(dest.file_name().unwrap().to_string_lossy(), format!("project{}", format.extension()));
        let mut written = 0;
        compress(std::slice::from_ref(&src), &dest, format, None, &mut |n| {
            written += n;
            true
        })
        .unwrap();
        assert_eq!(written, 5 + 300_000);

        // The original is still there, so the single top-level folder gets "project 2".
        let mut read = 0;
        let out = extract(&dest, None, &mut |n| {
            read += n;
            true
        })
        .unwrap();
        assert_eq!(out, tmp.path().join("project 2"));
        assert!(read > 0);
        assert_eq!(fs::read_to_string(out.join("a.txt")).unwrap(), "alpha");
        assert_eq!(fs::read(out.join("sub/b.bin")).unwrap().len(), 300_000);
        assert_eq!(fs::read_link(out.join("link")).unwrap(), Path::new("a.txt"));
        assert_eq!(fs::metadata(out.join("a.txt")).unwrap().mode() & 0o777, 0o750);
        assert!(!out.join(".DS_Store").exists());
        // Nothing temporary left behind.
        let leftovers: Vec<_> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn zip_round_trip() {
        round_trip(ArchiveFormat::Zip);
    }

    #[test]
    fn tar_gz_round_trip() {
        round_trip(ArchiveFormat::TarGz);
    }

    #[test]
    fn tar_zst_round_trip() {
        round_trip(ArchiveFormat::TarZst);
    }

    #[test]
    fn several_items_go_into_a_named_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let dest = archive_path(&[a.clone(), b.clone()], ArchiveFormat::Zip).unwrap();
        assert_eq!(dest, tmp.path().join("Archive.zip"));
        compress(&[a, b], &dest, ArchiveFormat::Zip, None, &mut |_| true).unwrap();
        let out = extract(&dest, None, &mut |_| true).unwrap();
        assert_eq!(out, tmp.path().join("Archive"));
        assert!(out.join("a.txt").exists() && out.join("b.txt").exists());
    }

    #[test]
    fn extracts_into_another_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tree(tmp.path());
        let dest = archive_path(std::slice::from_ref(&src), ArchiveFormat::Zip).unwrap();
        compress(std::slice::from_ref(&src), &dest, ArchiveFormat::Zip, None, &mut |_| true).unwrap();
        let other = tmp.path().join("other");
        fs::create_dir(&other).unwrap();
        let out = extract_to(&dest, &other, None, &mut |_| true).unwrap();
        assert_eq!(out, other.join("project"));
        assert_eq!(fs::read_to_string(out.join("a.txt")).unwrap(), "alpha");
        // Nothing staged was left in either folder.
        assert_eq!(fs::read_dir(&other).unwrap().count(), 1);
        assert!(
            !fs::read_dir(tmp.path())
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().contains("oxextract"))
        );
    }

    #[test]
    fn cancelling_leaves_nothing_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tree(tmp.path());
        let dest = archive_path(std::slice::from_ref(&src), ArchiveFormat::TarGz).unwrap();
        let e = compress(std::slice::from_ref(&src), &dest, ArchiveFormat::TarGz, None, &mut |_| false)
            .unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Interrupted);
        assert!(!dest.exists());

        compress(std::slice::from_ref(&src), &dest, ArchiveFormat::TarGz, None, &mut |_| true).unwrap();
        let e = extract(&dest, None, &mut |_| false).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Interrupted);
        let names: Vec<_> = fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
    }

    #[test]
    fn zip_slip_and_symlink_escapes_are_refused() {
        use zip::write::SimpleFileOptions;
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        fs::create_dir(&outside).unwrap();

        let evil = tmp.path().join("evil.zip");
        let mut z = zip::ZipWriter::new(File::create(&evil).unwrap());
        z.start_file("../escape.txt", SimpleFileOptions::default()).unwrap();
        z.write_all(b"x").unwrap();
        z.finish().unwrap();
        assert!(extract(&evil, None, &mut |_| true).is_err());
        assert!(!tmp.path().join("escape.txt").exists());

        let evil = tmp.path().join("evil2.zip");
        let mut z = zip::ZipWriter::new(File::create(&evil).unwrap());
        z.add_symlink("dir", outside.to_string_lossy(), SimpleFileOptions::default()).unwrap();
        z.start_file("dir/planted.txt", SimpleFileOptions::default()).unwrap();
        z.write_all(b"x").unwrap();
        z.finish().unwrap();
        assert!(extract(&evil, None, &mut |_| true).is_err());
        assert!(!outside.join("planted.txt").exists());
        // The staging folder is cleaned up.
        assert!(
            fs::read_dir(tmp.path()).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with('.'))
        );
    }

    #[test]
    fn lists_and_extracts_single_members() {
        for format in [ArchiveFormat::Zip, ArchiveFormat::TarGz, ArchiveFormat::TarZst] {
            let tmp = tempfile::tempdir().unwrap();
            let src = tree(tmp.path());
            let dest = archive_path(std::slice::from_ref(&src), format).unwrap();
            compress(std::slice::from_ref(&src), &dest, format, None, &mut |_| true).unwrap();

            let list = members(&dest).unwrap();
            let names: Vec<&str> = list.iter().map(|m| m.path.as_str()).collect();
            assert!(names.contains(&"project/sub/b.bin"), "{format:?} {names:?}");
            let bin = list.iter().find(|m| m.path == "project/sub/b.bin").unwrap();
            assert_eq!(bin.size, 300_000);
            assert!(list.iter().any(|m| m.path == "project/link" && m.is_symlink));

            let out = tmp.path().join("out");
            fs::create_dir(&out).unwrap();
            let created =
                extract_members(&dest, &["project/sub".into(), "project/a.txt".into()], &out, &mut |_| true)
                    .unwrap();
            assert_eq!(created.len(), 2, "{format:?}");
            assert_eq!(fs::read(out.join("sub/b.bin")).unwrap().len(), 300_000);
            assert_eq!(fs::read_to_string(out.join("a.txt")).unwrap(), "alpha");
            // Taken names get a number, nothing temporary stays.
            extract_members(&dest, &["project/a.txt".into()], &out, &mut |_| true).unwrap();
            assert!(out.join("a.txt 2").exists());
            assert!(
                fs::read_dir(&out).unwrap().all(|e| !e
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.'))
            );
        }
    }

    #[test]
    fn password_zip_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("secret.txt");
        fs::write(&src, b"top secret").unwrap();
        let dest = tmp.path().join("secret.zip");
        compress(std::slice::from_ref(&src), &dest, ArchiveFormat::Zip, Some("hunter2"), &mut |_| true)
            .unwrap();
        fs::remove_file(&src).unwrap();
        assert!(zip_encrypted(&dest).unwrap());
        // The contents aren't readable in the archive file itself.
        assert!(!fs::read(&dest).unwrap().windows(10).any(|w| w == b"top secret"));

        let missing = extract(&dest, None, &mut |_| true).unwrap_err();
        assert_eq!(missing.to_string(), "the archive needs a password");
        let wrong = extract(&dest, Some("nope"), &mut |_| true).unwrap_err();
        assert_eq!(wrong.to_string(), "the password is wrong");
        // Failed attempts leave nothing behind.
        assert!(!src.exists());
        assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);

        let out = extract(&dest, Some("hunter2"), &mut |_| true).unwrap();
        assert_eq!(fs::read(out).unwrap(), b"top secret");
        // An ordinary zip isn't encrypted.
        let plain = tmp.path().join("plain.zip");
        compress(std::slice::from_ref(&dest), &plain, ArchiveFormat::Zip, None, &mut |_| true).unwrap();
        assert!(!zip_encrypted(&plain).unwrap());
    }

    #[test]
    fn unlocked_zip_members_can_be_copied_out() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("note.txt");
        fs::write(&src, b"members too").unwrap();
        let zip = tmp.path().join("locked.zip");
        compress(std::slice::from_ref(&src), &zip, ArchiveFormat::Zip, Some("pw 1"), &mut |_| true).unwrap();
        let out = tmp.path().join("out");
        fs::create_dir(&out).unwrap();
        let names = ["note.txt".to_owned()];

        let locked = extract_members(&zip, &names, &out, &mut |_| true).unwrap_err();
        assert_eq!(locked.to_string(), "the archive needs a password");
        assert_eq!(unlock(&zip, "wrong").unwrap_err().to_string(), "the password is wrong");
        unlock(&zip, "pw 1").unwrap();
        let made = extract_members(&zip, &names, &out, &mut |_| true).unwrap();
        assert_eq!(fs::read(&made[0]).unwrap(), b"members too");
        // Nothing to unlock in a plain zip.
        let plain = tmp.path().join("plain.zip");
        compress(std::slice::from_ref(&src), &plain, ArchiveFormat::Zip, None, &mut |_| true).unwrap();
        assert!(unlock(&plain, "x").is_err());
    }
}
