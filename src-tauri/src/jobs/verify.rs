//! Verify Checksums: checks the files a checksum list names (`SHA256SUMS`,
//! `file.iso.sha256`, `.md5`, …) against their hashes. Both the GNU format
//! (`<hex>  name`, `<hex> *name`) and the BSD one (`SHA256 (name) = <hex>`)
//! are read; the algorithm follows from the hash's length.

use std::fs;
use std::io::{self, Read as _};
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use sha2::Digest;

/// Checksum lists are small; anything bigger isn't one.
const MAX_LIST: u64 = 4 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum HashKind {
    Md5,
    Sha1,
    Sha256,
    Sha512,
}

impl HashKind {
    fn from_hex_len(len: usize) -> Option<Self> {
        match len {
            32 => Some(Self::Md5),
            40 => Some(Self::Sha1),
            64 => Some(Self::Sha256),
            128 => Some(Self::Sha512),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum VerifyStatus {
    Ok,
    Mismatch,
    Missing,
    /// Couldn't be read (permissions, a folder, …), or a name that leaves the list's folder.
    Unreadable,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum VerifyEvent {
    /// The list was read: this many files to check.
    Started {
        total: u32,
    },
    Item {
        name: String,
        path: String,
        kind: HashKind,
        status: VerifyStatus,
    },
    Done {
        cancelled: bool,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub hex: String,
    pub kind: HashKind,
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// One line of a list, or None for blanks, comments and anything unrecognised.
fn parse_line(line: &str) -> Option<Entry> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() || line.starts_with('#') {
        return None;
    }
    // BSD: `SHA256 (name) = hex`
    if let Some((left, hex)) = line.rsplit_once(") = ")
        && let Some((_, name)) = left.split_once(" (")
        && is_hex(hex.trim())
    {
        let hex = hex.trim().to_ascii_lowercase();
        return Some(Entry { name: name.to_owned(), kind: HashKind::from_hex_len(hex.len())?, hex });
    }
    // GNU: `hex  name` (text) or `hex *name` (binary)
    let (hex, rest) = line.split_once(' ')?;
    let name = rest.strip_prefix(' ').or_else(|| rest.strip_prefix('*')).unwrap_or(rest);
    if !is_hex(hex) || name.is_empty() {
        return None;
    }
    Some(Entry {
        name: name.to_owned(),
        kind: HashKind::from_hex_len(hex.len())?,
        hex: hex.to_ascii_lowercase(),
    })
}

pub fn parse(text: &str) -> Vec<Entry> {
    text.lines().filter_map(parse_line).collect()
}

/// `name` inside `dir`; None when it would leave it (absolute, `..`).
fn resolve(dir: &Path, name: &str) -> Option<PathBuf> {
    let rel = Path::new(name);
    rel.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)).then(|| dir.join(rel))
}

fn hash_file<D: Digest>(path: &Path, stop: &dyn Fn() -> bool) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = D::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        if stop() {
            return Err(io::ErrorKind::Interrupted.into());
        }
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn hash(kind: HashKind, path: &Path, stop: &dyn Fn() -> bool) -> io::Result<String> {
    match kind {
        HashKind::Md5 => hash_file::<md5::Md5>(path, stop),
        HashKind::Sha1 => hash_file::<sha1::Sha1>(path, stop),
        HashKind::Sha256 => hash_file::<sha2::Sha256>(path, stop),
        HashKind::Sha512 => hash_file::<sha2::Sha512>(path, stop),
    }
}

/// Reads the list at `list` and checks each file, relative to the list's folder.
pub fn verify(
    list: &Path,
    stop: &dyn Fn() -> bool,
    emit: &mut dyn FnMut(VerifyEvent) -> bool,
) -> io::Result<()> {
    if fs::metadata(list)?.len() > MAX_LIST {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "this isn’t a checksum list"));
    }
    let entries = parse(&String::from_utf8_lossy(&fs::read(list)?));
    if entries.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "no checksums found in this file"));
    }
    let dir = list.parent().unwrap_or(Path::new("/"));
    if !emit(VerifyEvent::Started { total: u32::try_from(entries.len()).unwrap_or(u32::MAX) }) {
        return Ok(());
    }
    for e in entries {
        let target = resolve(dir, &e.name);
        let status = match &target {
            None => VerifyStatus::Unreadable,
            Some(p) if fs::symlink_metadata(p).is_err() => VerifyStatus::Missing,
            Some(p) => match hash(e.kind, p, stop) {
                Ok(h) if h == e.hex => VerifyStatus::Ok,
                Ok(_) => VerifyStatus::Mismatch,
                Err(err) if err.kind() == io::ErrorKind::Interrupted => break,
                Err(_) => VerifyStatus::Unreadable,
            },
        };
        let path = target.map_or_else(String::new, |p| p.to_string_lossy().into_owned());
        if stop() || !emit(VerifyEvent::Item { name: e.name, path, kind: e.kind, status }) {
            break;
        }
    }
    emit(VerifyEvent::Done { cancelled: stop() });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gnu_and_bsd_lines() {
        let sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let md5 = "d41d8cd98f00b204e9800998ecf8427e";
        let text = format!(
            "# comment\n{sha}  empty.txt\n{} *bin/x y.iso\nMD5 (a (1).txt) = {md5}\nnot a line\n{md5} \n",
            sha.to_uppercase()
        );
        let got = parse(&text);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], Entry { name: "empty.txt".into(), hex: sha.into(), kind: HashKind::Sha256 });
        assert_eq!(got[1].name, "bin/x y.iso");
        assert_eq!(got[1].hex, sha);
        assert_eq!(got[2], Entry { name: "a (1).txt".into(), hex: md5.into(), kind: HashKind::Md5 });
    }

    #[test]
    fn stays_in_the_folder() {
        let dir = Path::new("/x");
        assert_eq!(resolve(dir, "a/b.txt"), Some(PathBuf::from("/x/a/b.txt")));
        assert_eq!(resolve(dir, "../etc/passwd"), None);
        assert_eq!(resolve(dir, "/etc/passwd"), None);
    }

    #[test]
    fn verifies_files() {
        let dir = std::env::temp_dir().join(format!("ox-verify-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("good.txt"), "hello\n").unwrap();
        fs::write(dir.join("bad.txt"), "changed\n").unwrap();
        // `printf 'hello\n' | shasum -a 256` and `md5`
        let hello256 = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
        let hello1 = "f572d396fae9206628714fb2ce00f72e94f2258f";
        let list = dir.join("SHA256SUMS");
        fs::write(
            &list,
            format!("{hello256}  good.txt\n{hello256}  bad.txt\n{hello256}  gone.txt\n{hello1}  good.txt\n"),
        )
        .unwrap();
        let mut seen = Vec::new();
        verify(&list, &|| false, &mut |ev| {
            if let VerifyEvent::Item { name, status, .. } = ev {
                seen.push((name, status));
            }
            true
        })
        .unwrap();
        assert_eq!(
            seen,
            [
                ("good.txt".into(), VerifyStatus::Ok),
                ("bad.txt".into(), VerifyStatus::Mismatch),
                ("gone.txt".into(), VerifyStatus::Missing),
                ("good.txt".into(), VerifyStatus::Ok),
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }
}
