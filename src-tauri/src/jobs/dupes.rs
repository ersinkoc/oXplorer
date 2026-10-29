//! Find Duplicates: files under a folder with the same contents. Candidates are
//! narrowed by size, then by a hash of the first block, then by a full hash, so
//! most files are never read.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read as _};
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest as _, Sha256};

/// Bytes hashed first; files that differ usually differ early.
const HEAD: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DupEvent {
    /// Files looked at so far, and files whose contents were read.
    Progress {
        scanned: u32,
        hashed: u32,
    },
    /// Files with identical contents, sorted by path.
    Group {
        #[specta(type = u32)]
        size: u64,
        paths: Vec<String>,
    },
    Done {
        groups: u32,
    },
}

/// Walks `root` and reports groups through `emit`; stops (returning false) once
/// `emit` does or `stop` says so (checked while big files are read, too).
pub fn find(root: &Path, stop: &dyn Fn() -> bool, emit: &mut dyn FnMut(DupEvent) -> bool) -> bool {
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    let mut seen = HashSet::new();
    let mut stack = vec![root.to_path_buf()];
    let mut scanned = 0u32;
    while let Some(dir) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        for item in read.flatten() {
            let path = item.path();
            let Ok(meta) = fs::symlink_metadata(&path) else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() && meta.len() > 0 && seen.insert((meta.dev(), meta.ino())) {
                // Hard links are the same file, not duplicates.
                by_size.entry(meta.len()).or_default().push(path);
                scanned += 1;
                if scanned.is_multiple_of(2048) && !emit(DupEvent::Progress { scanned, hashed: 0 }) {
                    return false;
                }
            }
        }
    }

    let mut candidates: Vec<(u64, Vec<PathBuf>)> =
        by_size.into_iter().filter(|(_, paths)| paths.len() > 1).collect();
    // Biggest first: they waste the most space.
    candidates.sort_by_key(|(size, _)| std::cmp::Reverse(*size));
    let mut hashed = 0u32;
    let mut groups = 0u32;
    for (size, paths) in candidates {
        let heads = split_by(paths, |p| hash(p, Some(HEAD), stop));
        if stop() {
            return false;
        }
        for head in heads {
            hashed += u32::try_from(head.len()).unwrap_or(u32::MAX);
            if !emit(DupEvent::Progress { scanned, hashed }) {
                return false;
            }
            let same = if size <= HEAD { vec![head] } else { split_by(head, |p| hash(p, None, stop)) };
            if stop() {
                return false;
            }
            for mut group in same {
                group.sort();
                groups += 1;
                let paths = group.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                if !emit(DupEvent::Group { size, paths }) {
                    return false;
                }
            }
        }
    }
    emit(DupEvent::Done { groups })
}

/// Splits `paths` by `key`, keeping only groups of two or more (unreadable files drop out).
fn split_by(paths: Vec<PathBuf>, key: impl Fn(&Path) -> io::Result<[u8; 32]>) -> Vec<Vec<PathBuf>> {
    let mut by_key: HashMap<[u8; 32], Vec<PathBuf>> = HashMap::new();
    for p in paths {
        if let Ok(k) = key(&p) {
            by_key.entry(k).or_default().push(p);
        }
    }
    by_key.into_values().filter(|g| g.len() > 1).collect()
}

/// SHA-256 of the first `limit` bytes, or of the whole file.
fn hash(path: &Path, limit: Option<u64>, stop: &dyn Fn() -> bool) -> io::Result<[u8; 32]> {
    let file = fs::File::open(path)?;
    let mut reader: Box<dyn io::Read> = match limit {
        Some(n) => Box::new(file.take(n)),
        None => Box::new(file),
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        if stop() {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_identical_files_only() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("a.txt"), b"same").unwrap();
        fs::write(root.join("sub/b.txt"), b"same").unwrap();
        fs::write(root.join("c.txt"), b"diff").unwrap(); // same size, other contents
        fs::write(root.join("empty1"), b"").unwrap();
        fs::write(root.join("empty2"), b"").unwrap();
        fs::hard_link(root.join("c.txt"), root.join("c-link.txt")).unwrap();
        // Same first block, different ending.
        let mut big = vec![7u8; (HEAD as usize) + 10];
        fs::write(root.join("big1"), &big).unwrap();
        big[(HEAD as usize) + 5] = 8;
        fs::write(root.join("big2"), &big).unwrap();

        let mut groups = Vec::new();
        let mut done = None;
        assert!(find(&root, &|| false, &mut |ev| {
            match ev {
                DupEvent::Group { size, paths } => groups.push((size, paths)),
                DupEvent::Done { groups } => done = Some(groups),
                DupEvent::Progress { .. } => {}
            }
            true
        }));
        let s = |p: &str| root.join(p).to_string_lossy().into_owned();
        assert_eq!(groups, vec![(4, vec![s("a.txt"), s("sub/b.txt")])]);
        assert_eq!(done, Some(1));
    }

    #[test]
    fn stops_when_told() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("a"), b"x").unwrap();
        fs::write(tmp.path().join("b"), b"x").unwrap();
        assert!(!find(tmp.path(), &|| false, &mut |_| false));
        // Asked to stop while hashing: no group comes out.
        let mut groups = 0;
        assert!(!find(tmp.path(), &|| true, &mut |ev| {
            groups += u32::from(matches!(ev, DupEvent::Group { .. }));
            true
        }));
        assert_eq!(groups, 0);
    }
}
