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

/// Finder's naming: `name.zip` for one item, `Archive.zip` for several.
pub fn archive_path(sources: &[PathBuf], format: ArchiveFormat) -> Option<PathBuf> {
    let dir = sources.first()?.parent()?;
    let stem = match sources {
        [one] => one.file_name()?.to_string_lossy().into_owned(),
        _ => "Archive".to_owned(),
    };
    Some(unique(dir, &stem, format.extension()))
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
            zip.start_file(name, opts.large_file(meta.len() >= u64::from(u32::MAX)))
                .map_err(io::Error::other)?;
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
pub fn compress(
    sources: &[PathBuf],
    dest: &Path,
    format: ArchiveFormat,
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<()> {
    let base = sources.first().and_then(|s| s.parent()).unwrap_or(Path::new("/"));
    let items = collect(sources, base)?;
    let dir = dest.parent().unwrap_or(Path::new("/"));
    let name = dest.file_name().map_or_else(|| "archive".into(), |n| n.to_string_lossy().into_owned());
    let temp = dir.join(format!(".{name}.oxpart"));
    let mut stopped = false;
    let tick = &mut |n: u64| {
        let go = tick(n);
        stopped |= !go;
        go
    };
    let result = (|| {
        let out = File::create_new(&temp)?;
        match format {
            ArchiveFormat::Zip => write_zip(&items, out, tick)?,
            ArchiveFormat::TarGz => {
                let gz = flate2::write::GzEncoder::new(BufWriter::new(out), flate2::Compression::default());
                write_tar(&items, gz, tick)?.finish()?.flush()?;
            }
            ArchiveFormat::TarZst => {
                let zst = zstd::Encoder::new(BufWriter::new(out), 3)?;
                write_tar(&items, zst, tick)?.finish()?.flush()?;
            }
        }
        fs::rename(&temp, dest)
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

/// Maps a member's path inside the archive to where it goes under the staging
/// folder; `None` skips it.
type Select<'a> = &'a dyn Fn(&Path) -> Option<PathBuf>;

fn unzip(
    archive: &Path,
    staging: &Path,
    tick: &mut dyn FnMut(u64) -> bool,
    select: Select,
) -> io::Result<()> {
    let mut zip = zip::ZipArchive::new(BufReader::new(File::open(archive)?)).map_err(io::Error::other)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(io::Error::other)?;
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
            let mut target = String::new();
            entry.read_to_string(&mut target)?;
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

fn untar<R: Read>(reader: R, staging: &Path, select: Option<Select>) -> io::Result<()> {
    let mut tar = tar::Archive::new(reader);
    tar.set_preserve_permissions(true);
    tar.set_preserve_mtime(true);
    tar.set_unpack_xattrs(false);
    tar.set_overwrite(false);
    for entry in tar.entries()? {
        let mut entry = entry?;
        entry.set_mask(0o7000);
        let Some(select) = select else {
            if !entry.unpack_in(staging)? {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "unsafe path in archive"));
            }
            continue;
        };
        // Picking members: hard links would point at paths that may not be extracted.
        if entry.header().entry_type().is_hard_link() {
            continue;
        }
        let path = entry.path()?.into_owned();
        let Some(rel) = select(&normalize_member(&path)?) else { continue };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = safe_join(staging, &rel)?;
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        entry.unpack(&out)?;
    }
    Ok(())
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

/// Extracts next to the archive like Archive Utility: a single top-level item
/// lands as itself, anything else in a folder named after the archive.
pub fn extract(archive: &Path, tick: &mut dyn FnMut(u64) -> bool) -> io::Result<PathBuf> {
    let (kind, suffix) = kind_of(archive)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not a supported archive"))?;
    let dir = archive.parent().unwrap_or(Path::new("/"));
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
        match kind {
            Kind::Zip => unzip(archive, &staging, tick, &|p| Some(p.to_path_buf()))?,
            _ => {
                let raw = Progress { inner: BufReader::new(File::open(archive)?), tick: &mut *tick };
                match kind {
                    Kind::Tar => untar(raw, &staging, None)?,
                    Kind::TarGz => untar(flate2::read::GzDecoder::new(raw), &staging, None)?,
                    _ => untar(zstd::Decoder::new(raw)?, &staging, None)?,
                }
            }
        }
        let children: Vec<PathBuf> =
            fs::read_dir(&staging)?.filter_map(Result::ok).map(|e| e.path()).collect();
        if let [only] = children.as_slice() {
            let only_name = only.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            let target = unique(dir, &only_name, "");
            fs::rename(only, &target)?;
            fs::remove_dir(&staging)?;
            Ok(target)
        } else {
            let target = unique(dir, stem, "");
            fs::rename(&staging, &target)?;
            Ok(target)
        }
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
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
        match kind {
            Kind::Zip => unzip(archive, &staging, tick, &select)?,
            _ => {
                let raw = Progress { inner: BufReader::new(File::open(archive)?), tick: &mut *tick };
                match kind {
                    Kind::Tar => untar(raw, &staging, Some(&select))?,
                    Kind::TarGz => untar(flate2::read::GzDecoder::new(raw), &staging, Some(&select))?,
                    _ => untar(zstd::Decoder::new(raw)?, &staging, Some(&select))?,
                }
            }
        }
        let mut created = Vec::new();
        for child in fs::read_dir(&staging)?.filter_map(Result::ok) {
            let name = child.file_name().to_string_lossy().into_owned();
            let target = unique(dest, &name, "");
            fs::rename(child.path(), &target)?;
            created.push(target);
        }
        fs::remove_dir(&staging)?;
        Ok(created)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    if stopped { Err(cancelled()) } else { result }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        compress(std::slice::from_ref(&src), &dest, format, &mut |n| {
            written += n;
            true
        })
        .unwrap();
        assert_eq!(written, 5 + 300_000);

        // The original is still there, so the single top-level folder gets "project 2".
        let mut read = 0;
        let out = extract(&dest, &mut |n| {
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
        compress(&[a, b], &dest, ArchiveFormat::Zip, &mut |_| true).unwrap();
        let out = extract(&dest, &mut |_| true).unwrap();
        assert_eq!(out, tmp.path().join("Archive"));
        assert!(out.join("a.txt").exists() && out.join("b.txt").exists());
    }

    #[test]
    fn cancelling_leaves_nothing_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tree(tmp.path());
        let dest = archive_path(std::slice::from_ref(&src), ArchiveFormat::TarGz).unwrap();
        let e =
            compress(std::slice::from_ref(&src), &dest, ArchiveFormat::TarGz, &mut |_| false).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Interrupted);
        assert!(!dest.exists());

        compress(std::slice::from_ref(&src), &dest, ArchiveFormat::TarGz, &mut |_| true).unwrap();
        let e = extract(&dest, &mut |_| false).unwrap_err();
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
        assert!(extract(&evil, &mut |_| true).is_err());
        assert!(!tmp.path().join("escape.txt").exists());

        let evil = tmp.path().join("evil2.zip");
        let mut z = zip::ZipWriter::new(File::create(&evil).unwrap());
        z.add_symlink("dir", outside.to_string_lossy(), SimpleFileOptions::default()).unwrap();
        z.start_file("dir/planted.txt", SimpleFileOptions::default()).unwrap();
        z.write_all(b"x").unwrap();
        z.finish().unwrap();
        assert!(extract(&evil, &mut |_| true).is_err());
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
            compress(std::slice::from_ref(&src), &dest, format, &mut |_| true).unwrap();

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
}
