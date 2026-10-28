//! Disk usage of a folder tree for the treemap: allocated bytes per folder,
//! scanned in parallel, staying on one volume and counting hard links once.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rayon::prelude::*;
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};
use crate::security::validate_path;

/// Levels of folders sent to the frontend; deeper ones are rescanned when opened.
const SEND_DEPTH: usize = 4;
/// Children kept per folder (largest first); the rest are summed into one "other" node.
const KEEP_CHILDREN: usize = 60;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageNode {
    pub name: String,
    /// Allocated bytes on disk (what deleting it would free).
    #[specta(type = u32)]
    pub size: u64,
    pub files: u32,
    pub is_dir: bool,
    /// Several small items summed up; not a real file or folder.
    pub is_other: bool,
    /// Empty for files, "other" nodes, and folders below the depth sent.
    pub children: Vec<UsageNode>,
    /// A folder whose children weren't sent (below the depth limit).
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UsageEvent {
    Progress {
        #[specta(type = u32)]
        bytes: u64,
        files: u32,
    },
    Done {
        root: Option<UsageNode>,
        cancelled: bool,
    },
}

struct Scan {
    device: u64,
    cancel: Arc<AtomicBool>,
    bytes: AtomicU64,
    files: AtomicU64,
    seen_links: Mutex<HashSet<(u64, u64)>>,
}

impl Scan {
    /// Allocated size, or 0 for the second and later names of a hard-linked file.
    fn allocated(&self, meta: &fs::Metadata) -> u64 {
        if meta.nlink() > 1 && !meta.is_dir() {
            let fresh = self.seen_links.lock().map_or(true, |mut s| s.insert((meta.dev(), meta.ino())));
            if !fresh {
                return 0;
            }
        }
        meta.blocks() * 512
    }

    fn node(&self, path: &Path, name: String, meta: &fs::Metadata) -> UsageNode {
        if !meta.is_dir() {
            let size = self.allocated(meta);
            self.bytes.fetch_add(size, Ordering::Relaxed);
            self.files.fetch_add(1, Ordering::Relaxed);
            return UsageNode {
                name,
                size,
                files: 1,
                is_dir: false,
                is_other: false,
                children: Vec::new(),
                truncated: false,
            };
        }
        let own = meta.blocks() * 512;
        // Another volume mounted inside (or a firmlink to one) isn't part of this folder.
        if meta.dev() != self.device || self.cancel.load(Ordering::Relaxed) {
            return UsageNode {
                name,
                size: own,
                files: 0,
                is_dir: true,
                is_other: false,
                children: Vec::new(),
                truncated: false,
            };
        }
        let entries: Vec<(PathBuf, String)> = fs::read_dir(path)
            .map(|rd| {
                rd.filter_map(Result::ok)
                    .map(|e| (e.path(), e.file_name().to_string_lossy().into_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let children: Vec<UsageNode> = entries
            .into_par_iter()
            .filter_map(|(p, n)| fs::symlink_metadata(&p).ok().map(|m| self.node(&p, n, &m)))
            .collect();
        let size = own + children.iter().map(|c| c.size).sum::<u64>();
        let files = children.iter().map(|c| c.files).fold(0u32, u32::saturating_add);
        UsageNode { name, size, files, is_dir: true, is_other: false, children, truncated: false }
    }
}

/// Largest children first, the tail folded into "other", and nothing below `depth`.
fn prune(mut node: UsageNode, depth: usize) -> UsageNode {
    if !node.is_dir || node.children.is_empty() {
        return node;
    }
    if depth == 0 {
        node.children.clear();
        node.truncated = true;
        return node;
    }
    node.children.sort_by_key(|c| std::cmp::Reverse(c.size));
    if node.children.len() > KEEP_CHILDREN {
        let rest = node.children.split_off(KEEP_CHILDREN);
        node.children.push(UsageNode {
            name: format!("{} more", rest.len()),
            size: rest.iter().map(|c| c.size).sum(),
            files: rest.iter().map(|c| c.files).fold(0u32, u32::saturating_add),
            is_dir: false,
            is_other: true,
            children: Vec::new(),
            truncated: false,
        });
    }
    node.children = node.children.into_iter().map(|c| prune(c, depth - 1)).collect();
    node
}

pub fn scan(
    root: &Path,
    cancel: Arc<AtomicBool>,
    progress: &(dyn Fn(u64, u64) + Sync),
) -> AppResult<Option<UsageNode>> {
    let meta = fs::symlink_metadata(root).map_err(|e| AppError::from_io(&e, root))?;
    if !meta.is_dir() {
        return Err(AppError::NotADirectory { path: root.to_string_lossy().into_owned() });
    }
    let state = Arc::new(Scan {
        device: meta.dev(),
        cancel: Arc::clone(&cancel),
        bytes: AtomicU64::new(0),
        files: AtomicU64::new(0),
        seen_links: Mutex::new(HashSet::new()),
    });
    let done = Arc::new(AtomicBool::new(false));
    let name = root.file_name().map_or_else(|| "/".to_owned(), |n| n.to_string_lossy().into_owned());
    let tree = std::thread::scope(|s| {
        let reporter = s.spawn(|| {
            while !done.load(Ordering::Relaxed) {
                std::thread::park_timeout(Duration::from_millis(200));
                progress(state.bytes.load(Ordering::Relaxed), state.files.load(Ordering::Relaxed));
            }
        });
        let tree = state.node(root, name, &meta);
        done.store(true, Ordering::Relaxed);
        reporter.thread().unpark();
        tree
    });
    if cancel.load(Ordering::Relaxed) {
        return Ok(None);
    }
    Ok(Some(prune(tree, SEND_DEPTH)))
}

#[derive(Default)]
pub struct UsageScans(Mutex<HashMap<String, Arc<AtomicBool>>>);

/// Scans `path`; progress and the result (`Done`) arrive through `on_event`.
#[tauri::command]
#[specta::specta]
pub async fn disk_usage(
    scans: State<'_, Arc<UsageScans>>,
    id: String,
    path: String,
    on_event: Channel<UsageEvent>,
) -> AppResult<()> {
    let root = validate_path(&path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut m) = scans.0.lock() {
        m.insert(id.clone(), Arc::clone(&cancel));
    }
    let scans = Arc::clone(&scans);
    tauri::async_runtime::spawn_blocking(move || {
        let report = |bytes: u64, files: u64| {
            let _ = on_event
                .send(UsageEvent::Progress { bytes, files: u32::try_from(files).unwrap_or(u32::MAX) });
        };
        let result = scan(&root, Arc::clone(&cancel), &report);
        if let Ok(mut m) = scans.0.lock() {
            m.remove(&id);
        }
        let root = result?;
        let _ = on_event.send(UsageEvent::Done { cancelled: root.is_none(), root });
        Ok(())
    })
    .await
    .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

#[tauri::command]
#[specta::specta]
pub fn disk_usage_cancel(scans: State<'_, Arc<UsageScans>>, id: String) {
    if let Ok(m) = scans.0.lock()
        && let Some(flag) = m.get(&id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_folders_and_counts_hard_links_once() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        fs::create_dir_all(r.join("big/deeper")).unwrap();
        fs::write(r.join("big/deeper/blob"), vec![1u8; 1 << 20]).unwrap();
        fs::write(r.join("small.txt"), "x").unwrap();
        fs::hard_link(r.join("big/deeper/blob"), r.join("link-to-blob")).unwrap();

        let tree = scan(r, Arc::new(AtomicBool::new(false)), &|_, _| {}).unwrap().unwrap();
        assert_eq!(tree.files, 3);
        // Whichever name of the hard link is met first carries the size; the other adds nothing.
        assert!(tree.size >= 1 << 20 && tree.size < 2 * (1 << 20), "{}", tree.size);
        // Largest first.
        assert!(tree.children.windows(2).all(|w| w[0].size >= w[1].size));
    }

    #[test]
    fn prunes_depth_and_folds_the_tail() {
        let leaf = |i: u64| UsageNode {
            name: format!("f{i}"),
            size: i,
            files: 1,
            is_dir: false,
            is_other: false,
            children: Vec::new(),
            truncated: false,
        };
        let deep = UsageNode {
            name: "d".into(),
            size: 1,
            files: 0,
            is_dir: true,
            is_other: false,
            children: vec![UsageNode { children: vec![leaf(1)], is_dir: true, ..leaf(1) }],
            truncated: false,
        };
        let root = UsageNode {
            name: "r".into(),
            size: 0,
            files: 0,
            is_dir: true,
            is_other: false,
            children: (0..100).map(leaf).chain(std::iter::once(deep)).collect(),
            truncated: false,
        };
        let p = prune(root, 1);
        assert_eq!(p.children.len(), KEEP_CHILDREN + 1);
        let other = p.children.last().unwrap();
        assert!(other.is_other);
        assert_eq!(p.children[0].name, "f99");
        let d = p.children.iter().find(|c| c.name == "d");
        assert!(d.is_none_or(|d| d.truncated && d.children.is_empty()));
    }

    #[test]
    fn cancelled_scan_returns_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("a")).unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        assert!(scan(tmp.path(), cancel, &|_, _| {}).unwrap().is_none());
    }

    /// `OX_BENCH_DIR=~ cargo test --release --lib bench_usage -- --ignored --nocapture`
    #[test]
    #[ignore = "manual benchmark"]
    fn bench_usage() {
        let dir = std::env::var("OX_BENCH_DIR").map_or_else(|_| ".".into(), PathBuf::from);
        let t = std::time::Instant::now();
        let tree = scan(&dir, Arc::new(AtomicBool::new(false)), &|_, _| {}).unwrap().unwrap();
        let json = serde_json::to_string(&tree).unwrap().len();
        println!(
            "{} files, {} MB in {:?}, {} KB json",
            tree.files,
            tree.size >> 20,
            t.elapsed(),
            json / 1024
        );
    }
}
