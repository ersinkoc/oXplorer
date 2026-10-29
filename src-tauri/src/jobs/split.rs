//! Split File / Combine Files: a big file cut into numbered parts
//! (`movie.mkv.001`, `.002`, …, the scheme 7-Zip and Total Commander use) and
//! joined back. Parts are written with `create_new`, so nothing is overwritten.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use super::names;

/// More parts than this would run out of three-digit suffixes.
const MAX_PARTS: u64 = 999;
const BUF: usize = 1 << 20;

fn file_name(p: &Path) -> String {
    p.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_owned())
}

/// `name.001`, `name.002`, …
fn part_path(dir: &Path, name: &str, n: u64) -> PathBuf {
    dir.join(format!("{name}.{n:03}"))
}

/// How many parts `len` bytes make; errors when splitting makes no sense.
pub fn part_count(len: u64, part_size: u64) -> io::Result<u64> {
    if part_size == 0 {
        return Err(invalid("the part size must be more than 0"));
    }
    if len <= part_size {
        return Err(invalid("the file is smaller than one part"));
    }
    let count = len.div_ceil(part_size);
    if count > MAX_PARTS {
        return Err(invalid("that would make more than 999 parts; choose a bigger part size"));
    }
    Ok(count)
}

/// Copies up to `limit` bytes; `tick` gets byte counts and returns false to stop.
fn copy_some(
    from: &mut impl Read,
    to: &mut impl Write,
    limit: u64,
    buf: &mut [u8],
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<u64> {
    let mut done = 0;
    while done < limit {
        let want = usize::try_from(limit - done).map_or(buf.len(), |l| l.min(buf.len()));
        let n = from.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n])?;
        done += n as u64;
        if !tick(n as u64) {
            return Err(io::ErrorKind::Interrupted.into());
        }
    }
    Ok(done)
}

/// Cuts `src` into parts of `part_size` bytes in `dest_dir`. On failure or
/// cancel (`Interrupted`) the parts written so far are removed.
pub fn split(
    src: &Path,
    dest_dir: &Path,
    part_size: u64,
    tick: &mut dyn FnMut(u64) -> bool,
) -> io::Result<Vec<PathBuf>> {
    let meta = fs::metadata(src)?;
    if !meta.is_file() {
        return Err(invalid("only files can be split"));
    }
    let count = part_count(meta.len(), part_size)?;
    let name = file_name(src);
    if let Some(taken) =
        (1..=count).map(|n| part_path(dest_dir, &name, n)).find(|p| p.symlink_metadata().is_ok())
    {
        // Reported against the source, so say which part is in the way.
        return Err(io::Error::other(format!("“{}” already exists there", file_name(&taken))));
    }
    let mut input = File::open(src)?;
    let mut buf = vec![0; BUF];
    let mut made = Vec::new();
    let result = (|| {
        for n in 1..=count {
            let path = part_path(dest_dir, &name, n);
            let mut out = OpenOptions::new().write(true).create_new(true).open(&path)?;
            made.push(path);
            copy_some(&mut input, &mut out, part_size, &mut buf, tick)?;
            out.sync_all()?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(made),
        Err(e) => {
            for p in &made {
                let _ = fs::remove_file(p);
            }
            Err(e)
        }
    }
}

/// The name the parts came from: `movie.mkv.001` → `movie.mkv`.
pub fn joined_name(first: &Path) -> Option<String> {
    let name = file_name(first);
    name.strip_suffix(".001").filter(|stem| !stem.is_empty()).map(str::to_owned)
}

/// `first` (a `.001` file) and the parts that follow it, in order.
pub fn parts(first: &Path) -> io::Result<Vec<PathBuf>> {
    let stem = joined_name(first).ok_or_else(|| invalid("choose the first part (a file ending in .001)"))?;
    let dir = first.parent().unwrap_or(Path::new("/"));
    let found: Vec<PathBuf> = (1..=MAX_PARTS)
        .map(|n| part_path(dir, &stem, n))
        .take_while(|p| fs::metadata(p).is_ok_and(|m| m.is_file()))
        .collect();
    if found.is_empty() {
        return Err(io::ErrorKind::NotFound.into());
    }
    Ok(found)
}

/// Joins the parts starting at `first` into one file in `dest_dir`, under the
/// original name (or the next free one). A failed or cancelled join leaves nothing.
pub fn join(first: &Path, dest_dir: &Path, tick: &mut dyn FnMut(u64) -> bool) -> io::Result<PathBuf> {
    let parts = parts(first)?;
    let stem = joined_name(first).unwrap_or_default();
    let (dest, mut out) = create_free(dest_dir, &stem)?;
    let mut buf = vec![0; BUF];
    let result = (|| {
        for part in &parts {
            copy_some(&mut File::open(part)?, &mut out, u64::MAX, &mut buf, tick)?;
        }
        out.sync_all()
    })();
    match result {
        Ok(()) => Ok(dest),
        Err(e) => {
            let _ = fs::remove_file(&dest);
            Err(e)
        }
    }
}

/// Creates the first free variant of `name`; a name taken in the meantime is skipped.
fn create_free(dir: &Path, name: &str) -> io::Result<(PathBuf, File)> {
    for _ in 0..100 {
        let path = names::untitled(dir, name, true);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(f) => return Ok((path, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(io::ErrorKind::AlreadyExists.into())
}

/// Bytes `join` will write.
pub fn joined_size(first: &Path) -> u64 {
    parts(first).map_or(0, |ps| ps.iter().filter_map(|p| fs::metadata(p).ok()).map(|m| m.len()).sum())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ox-split-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn split_and_join_round_trip() {
        let dir = temp("round");
        let data: Vec<u8> = (0..2_500_000u32).map(|i| (i % 251) as u8).collect();
        let src = dir.join("big.bin");
        fs::write(&src, &data).unwrap();
        let out = dir.join("out");
        fs::create_dir(&out).unwrap();

        let made = split(&src, &out, 1_000_000, &mut |_| true).unwrap();
        let names: Vec<String> = made.iter().map(|p| file_name(p)).collect();
        assert_eq!(names, ["big.bin.001", "big.bin.002", "big.bin.003"]);
        assert_eq!(fs::metadata(&made[2]).unwrap().len(), 500_000);

        // Splitting again would overwrite: refused, nothing changes.
        let again = split(&src, &out, 1_000_000, &mut |_| true).unwrap_err();
        assert!(again.to_string().contains("big.bin.001"));

        assert_eq!(joined_size(&made[0]), data.len() as u64);
        // The original is still there, so the joined copy gets a free name.
        let joined = join(&made[0], &dir, &mut |_| true).unwrap();
        assert_eq!(file_name(&joined), "big 2.bin");
        assert_eq!(fs::read(&joined).unwrap(), data);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cancel_leaves_nothing() {
        let dir = temp("cancel");
        let src = dir.join("a.bin");
        fs::write(&src, vec![7u8; 3_000_000]).unwrap();
        let mut seen = 0;
        let e = split(&src, &dir, 1_000_000, &mut |n| {
            seen += n;
            seen < 1_500_000
        })
        .unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Interrupted);
        assert!(!dir.join("a.bin.001").exists() && !dir.join("a.bin.002").exists());

        let made = split(&src, &dir, 1_000_000, &mut |_| true).unwrap();
        let mut seen = 0;
        let e = join(&made[0], &dir, &mut |n| {
            seen += n;
            seen < 1_500_000
        })
        .unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::Interrupted);
        assert!(!dir.join("a 2.bin").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_nonsense() {
        assert!(part_count(10, 0).is_err());
        assert!(part_count(10, 10).is_err());
        assert_eq!(part_count(11, 10).unwrap(), 2);
        assert!(part_count(1000, 1).is_err());
        assert_eq!(joined_name(Path::new("/x/a.zip.001")).as_deref(), Some("a.zip"));
        assert_eq!(joined_name(Path::new("/x/a.zip.002")), None);
        assert_eq!(joined_name(Path::new("/x/.001")), None);
    }
}
