//! Synchronize Folders: what differs between two folder trees. Items that exist
//! on one side only are reported once (their contents aren't walked); folders on
//! both sides are compared inside; files differ by size or modification time.

use std::collections::BTreeMap;
use std::fs::{self, Metadata};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// File systems such as FAT store times in 2-second steps.
const TIME_SLACK_MS: f64 = 2000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncStatus {
    LeftOnly,
    RightOnly,
    LeftNewer,
    RightNewer,
    /// Same time, different size (or a file on one side and a folder on the other).
    Differs,
}

/// One side of a difference.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncSide {
    pub dir: bool,
    #[specta(type = u32)]
    pub size: u64,
    pub modified_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SyncEvent {
    /// Folders compared so far.
    Progress {
        folders: u32,
    },
    Item {
        /// Path below both roots, "/"-separated.
        rel: String,
        status: SyncStatus,
        left: Option<SyncSide>,
        right: Option<SyncSide>,
    },
    Done {
        items: u32,
    },
}

/// Compares `left` with `right`, streaming differences through `emit`; stops
/// (returning false) once `emit` does.
pub fn compare(left: &Path, right: &Path, emit: &mut dyn FnMut(SyncEvent) -> bool) -> bool {
    let mut walk = Walk { emit, folders: 0, items: 0 };
    if !walk.dir(left, right, "") {
        return false;
    }
    let items = walk.items;
    (walk.emit)(SyncEvent::Done { items })
}

struct Walk<'a> {
    emit: &'a mut dyn FnMut(SyncEvent) -> bool,
    folders: u32,
    items: u32,
}

impl Walk<'_> {
    fn dir(&mut self, left: &Path, right: &Path, rel: &str) -> bool {
        self.folders += 1;
        if self.folders.is_multiple_of(64) && !(self.emit)(SyncEvent::Progress { folders: self.folders }) {
            return false;
        }
        // Matched by folded name: either side may store a name decomposed (NFD).
        let mut names: BTreeMap<String, (Option<String>, Option<String>)> = BTreeMap::new();
        for (name, is_left) in list(left).map(|n| (n, true)).chain(list(right).map(|n| (n, false))) {
            let slot = names.entry(fold(&name)).or_default();
            if is_left { slot.0 = Some(name) } else { slot.1 = Some(name) }
        }
        for (l, r) in names.into_values() {
            let name = l.as_deref().or(r.as_deref()).unwrap_or_default();
            let child = if rel.is_empty() { name.to_owned() } else { format!("{rel}/{name}") };
            let lm = l.as_ref().and_then(|n| fs::symlink_metadata(left.join(n)).ok());
            let rm = r.as_ref().and_then(|n| fs::symlink_metadata(right.join(n)).ok());
            let keep_going = match (lm, rm) {
                (Some(lm), Some(rm)) if lm.is_dir() && rm.is_dir() => {
                    let (Some(l), Some(r)) = (&l, &r) else { continue };
                    self.dir(&left.join(l), &right.join(r), &child)
                }
                (Some(lm), Some(rm)) => match status(&lm, &rm) {
                    Some(s) => self.item(child, s, Some(&lm), Some(&rm)),
                    None => true,
                },
                (Some(lm), None) => self.item(child, SyncStatus::LeftOnly, Some(&lm), None),
                (None, Some(rm)) => self.item(child, SyncStatus::RightOnly, None, Some(&rm)),
                (None, None) => true,
            };
            if !keep_going {
                return false;
            }
        }
        true
    }

    fn item(&mut self, rel: String, status: SyncStatus, l: Option<&Metadata>, r: Option<&Metadata>) -> bool {
        self.items += 1;
        (self.emit)(SyncEvent::Item { rel, status, left: l.map(side), right: r.map(side) })
    }
}

fn list(dir: &Path) -> impl Iterator<Item = String> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        // Finder's folder settings aren't content.
        .filter(|n| n != ".DS_Store")
}

/// How two non-folder items differ, or None when they look the same.
fn status(l: &Metadata, r: &Metadata) -> Option<SyncStatus> {
    let (lt, rt) = (modified_ms(l), modified_ms(r));
    if l.is_dir() != r.is_dir() {
        return Some(newer(lt, rt).unwrap_or(SyncStatus::Differs));
    }
    if l.len() == r.len() && (lt - rt).abs() <= TIME_SLACK_MS {
        return None;
    }
    Some(newer(lt, rt).unwrap_or(SyncStatus::Differs))
}

fn newer(lt: f64, rt: f64) -> Option<SyncStatus> {
    if lt - rt > TIME_SLACK_MS {
        Some(SyncStatus::LeftNewer)
    } else if rt - lt > TIME_SLACK_MS {
        Some(SyncStatus::RightNewer)
    } else {
        None
    }
}

fn side(m: &Metadata) -> SyncSide {
    SyncSide { dir: m.is_dir(), size: if m.is_dir() { 0 } else { m.len() }, modified_ms: modified_ms(m) }
}

fn modified_ms(m: &Metadata) -> f64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

fn fold(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization as _;
    s.nfc().collect::<String>().to_lowercase()
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use super::*;

    fn touch(p: &Path, contents: &[u8], age_secs: u64) {
        fs::write(p, contents).unwrap();
        let f = fs::File::options().write(true).open(p).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(age_secs)).unwrap();
    }

    #[test]
    fn reports_what_differs() {
        let tmp = tempfile::tempdir().unwrap();
        let (l, r) = (tmp.path().join("l"), tmp.path().join("r"));
        for d in [&l, &r] {
            fs::create_dir_all(d.join("sub")).unwrap();
            touch(&d.join("same.txt"), b"same", 100);
            touch(&d.join(".DS_Store"), d.to_string_lossy().as_bytes(), 0);
        }
        touch(&l.join("sub/new.txt"), b"left is newer", 10);
        touch(&r.join("sub/new.txt"), b"old", 1000);
        touch(&l.join("size.txt"), b"aaaa", 50);
        touch(&r.join("size.txt"), b"bb", 50);
        fs::create_dir_all(l.join("only/deep")).unwrap();
        touch(&r.join("right.txt"), b"r", 5);
        // "é" decomposed on one side is the same name.
        touch(&l.join("caf\u{e9}.txt"), b"x", 100);
        touch(&r.join("cafe\u{301}.txt"), b"x", 100);

        let mut items = Vec::new();
        let mut done = None;
        assert!(compare(&l, &r, &mut |ev| {
            match ev {
                SyncEvent::Item { rel, status, .. } => items.push((rel, status)),
                SyncEvent::Done { items } => done = Some(items),
                SyncEvent::Progress { .. } => {}
            }
            true
        }));
        assert_eq!(
            items,
            vec![
                ("only".to_owned(), SyncStatus::LeftOnly),
                ("right.txt".to_owned(), SyncStatus::RightOnly),
                ("size.txt".to_owned(), SyncStatus::Differs),
                ("sub/new.txt".to_owned(), SyncStatus::LeftNewer),
            ]
        );
        assert_eq!(done, Some(4));
    }

    #[test]
    fn stops_when_told() {
        let tmp = tempfile::tempdir().unwrap();
        let (l, r) = (tmp.path().join("l"), tmp.path().join("r"));
        fs::create_dir_all(&l).unwrap();
        fs::create_dir_all(&r).unwrap();
        fs::write(l.join("a"), b"x").unwrap();
        assert!(!compare(&l, &r, &mut |_| false));
    }
}
