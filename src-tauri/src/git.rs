//! Git status for the folder a pane shows, reduced to its direct children:
//! a file's own state, or for a folder the "loudest" state of anything inside.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::security::validate_path;

/// Large repositories (or a home folder under git) give up after this long.
const TIMEOUT: Duration = Duration::from_secs(5);

/// Ordered by how much it matters to see: a folder shows its highest state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum GitState {
    Ignored,
    Untracked,
    Added,
    Renamed,
    Modified,
    Deleted,
    Conflict,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitChild {
    pub name: String,
    pub state: GitState,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// The repository's working tree.
    pub root: String,
    /// Branch name, or the short commit id when detached.
    pub branch: Option<String>,
    /// Set when the whole folder is untracked or ignored.
    pub folder: Option<GitState>,
    pub children: Vec<GitChild>,
    /// The status walk hit the time limit; what's here may be incomplete.
    pub partial: bool,
}

fn branch(repo: &gix::Repository) -> Option<String> {
    match repo.head_name().ok().flatten() {
        Some(name) => Some(name.shorten().to_string()),
        None => repo.head_id().ok().map(|id| id.shorten_or_id().to_string()),
    }
}

/// Repository-relative state of every changed path (untracked and ignored
/// folders collapsed to the folder itself).
fn changed_paths(
    repo: &gix::Repository,
    prefix: &str,
    interrupt: Arc<AtomicBool>,
) -> AppResult<Vec<(String, GitState)>> {
    use gix::diff::index::ChangeRef;
    use gix::dir::walk::EmissionMode;
    use gix::status::index_worktree::iter::Summary;

    let io = |e: &dyn std::fmt::Display| AppError::Io { path: None, message: format!("git status: {e}") };
    let patterns = if prefix.is_empty() { Vec::new() } else { vec![format!("{prefix}/").into()] };
    let iter = repo
        .status(gix::progress::Discard)
        .map_err(|e| io(&e))?
        .should_interrupt_owned(interrupt)
        .untracked_files(gix::status::UntrackedFiles::Collapsed)
        .dirwalk_options(|o| o.emit_ignored(Some(EmissionMode::CollapseDirectory)))
        .index_worktree_rewrites(None)
        .into_iter(patterns)
        .map_err(|e| io(&e))?;

    let mut out = Vec::new();
    for item in iter {
        let Ok(item) = item else { continue };
        let path = item.location().to_string();
        let state = match &item {
            gix::status::Item::TreeIndex(change) => match change {
                ChangeRef::Addition { .. } => GitState::Added,
                ChangeRef::Deletion { .. } => GitState::Deleted,
                ChangeRef::Modification { .. } => GitState::Modified,
                ChangeRef::Rewrite { .. } => GitState::Renamed,
            },
            gix::status::Item::IndexWorktree(change) => {
                if let gix::status::index_worktree::Item::DirectoryContents { entry, .. } = change
                    && matches!(entry.status, gix::dir::entry::Status::Ignored(_))
                {
                    GitState::Ignored
                } else {
                    match change.summary() {
                        Some(Summary::Added) => GitState::Untracked,
                        Some(Summary::Removed) => GitState::Deleted,
                        Some(Summary::Conflict) => GitState::Conflict,
                        Some(Summary::Renamed | Summary::Copied) => GitState::Renamed,
                        Some(Summary::Modified | Summary::TypeChange) => GitState::Modified,
                        Some(Summary::IntentToAdd) => GitState::Added,
                        None => continue,
                    }
                }
            }
        };
        out.push((path.trim_end_matches('/').to_owned(), state));
    }
    Ok(out)
}

/// Folds repository-relative changes into states of the children of `prefix`.
fn reduce(prefix: &str, changes: &[(String, GitState)]) -> (Option<GitState>, Vec<GitChild>) {
    let mut children: HashMap<String, GitState> = HashMap::new();
    let mut folder = None;
    for (path, state) in changes {
        let rest = if prefix.is_empty() {
            Some(path.as_str())
        } else if let Some(rest) = path.strip_prefix(prefix) {
            rest.strip_prefix('/')
        } else {
            None
        };
        match rest {
            Some(rest) if !rest.is_empty() => {
                let (name, nested) = rest.split_once('/').map_or((rest, false), |(n, _)| (n, true));
                // Something ignored deep inside doesn't make the folder "ignored".
                if nested && *state == GitState::Ignored {
                    continue;
                }
                let slot = children.entry(name.to_owned()).or_insert(*state);
                *slot = (*slot).max(*state);
            }
            // The folder itself, or one of its parents, is untracked/ignored as a whole.
            _ if prefix == path.as_str() || prefix.starts_with(&format!("{path}/")) => {
                if matches!(state, GitState::Untracked | GitState::Ignored) {
                    folder = Some(*state);
                }
            }
            _ => {}
        }
    }
    let mut children: Vec<GitChild> =
        children.into_iter().map(|(name, state)| GitChild { name, state }).collect();
    children.sort_by(|a, b| a.name.cmp(&b.name));
    (folder, children)
}

pub fn status_of(dir: &Path) -> AppResult<Option<GitStatus>> {
    // gix reports the working tree resolved (/private/var/…), so compare like with like.
    let dir = &dir.canonicalize().map_err(|e| AppError::from_io(&e, dir))?;
    let Ok(repo) = gix::discover(dir) else { return Ok(None) };
    let Some(workdir) = repo.workdir().map(Path::to_path_buf) else { return Ok(None) };
    // Inside `.git` itself there's nothing to show.
    let Ok(rel) = dir.strip_prefix(&workdir) else { return Ok(None) };
    if rel.components().next().is_some_and(|c| c.as_os_str() == ".git") {
        return Ok(None);
    }
    let prefix = rel.to_string_lossy().replace('\\', "/");

    let interrupt = Arc::new(AtomicBool::new(false));
    let timer = {
        let flag = Arc::clone(&interrupt);
        std::thread::spawn(move || {
            std::thread::park_timeout(TIMEOUT);
            flag.store(true, Ordering::Relaxed);
        })
    };
    let changes = changed_paths(&repo, &prefix, Arc::clone(&interrupt));
    let partial = interrupt.swap(true, Ordering::Relaxed);
    timer.thread().unpark();
    let (folder, children) = reduce(&prefix, &changes?);
    Ok(Some(GitStatus {
        root: workdir.to_string_lossy().into_owned(),
        branch: branch(&repo),
        folder,
        children,
        partial,
    }))
}

/// Git state of a folder's children, or `None` outside a repository.
#[tauri::command]
#[specta::specta]
pub async fn git_status(path: String) -> AppResult<Option<GitStatus>> {
    let dir = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || status_of(&dir))
        .await
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    fn state(s: &GitStatus, name: &str) -> Option<GitState> {
        s.children.iter().find(|c| c.name == name).map(|c| c.state)
    }

    #[test]
    fn reduces_changes_to_children() {
        let changes = vec![
            ("src/a.rs".to_owned(), GitState::Modified),
            ("src/deep/b.rs".to_owned(), GitState::Untracked),
            ("src/deep/target".to_owned(), GitState::Ignored),
            ("src/new".to_owned(), GitState::Untracked),
            ("other/x".to_owned(), GitState::Conflict),
        ];
        let (folder, kids) = reduce("src", &changes);
        assert_eq!(folder, None);
        let get = |n: &str| kids.iter().find(|c| c.name == n).map(|c| c.state);
        assert_eq!(get("a.rs"), Some(GitState::Modified));
        assert_eq!(get("deep"), Some(GitState::Untracked));
        assert_eq!(get("new"), Some(GitState::Untracked));
        assert_eq!(get("x"), None);
        // Inside an untracked folder everything is untracked.
        assert_eq!(reduce("src/new/inner", &changes).0, Some(GitState::Untracked));
    }

    #[test]
    fn reports_real_repository_states() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        git(r, &["init", "-q", "-b", "main"]);
        std::fs::create_dir_all(r.join("src")).unwrap();
        std::fs::write(r.join("src/lib.rs"), "1").unwrap();
        std::fs::write(r.join("README.md"), "x").unwrap();
        std::fs::write(r.join(".gitignore"), "target/\n").unwrap();
        git(r, &["add", "."]);
        git(r, &["commit", "-q", "-m", "init"]);

        std::fs::write(r.join("src/lib.rs"), "2").unwrap();
        std::fs::write(r.join("new.txt"), "n").unwrap();
        std::fs::write(r.join("staged.txt"), "s").unwrap();
        git(r, &["add", "staged.txt"]);
        std::fs::create_dir_all(r.join("target/debug")).unwrap();
        std::fs::write(r.join("target/debug/out"), "o").unwrap();

        let s = status_of(r).unwrap().unwrap();
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert!(!s.partial);
        assert_eq!(state(&s, "src"), Some(GitState::Modified));
        assert_eq!(state(&s, "new.txt"), Some(GitState::Untracked));
        assert_eq!(state(&s, "staged.txt"), Some(GitState::Added));
        assert_eq!(state(&s, "target"), Some(GitState::Ignored));
        assert_eq!(state(&s, "README.md"), None);

        let inner = status_of(&r.join("src")).unwrap().unwrap();
        assert_eq!(state(&inner, "lib.rs"), Some(GitState::Modified));
        let ignored = status_of(&r.join("target/debug")).unwrap().unwrap();
        assert_eq!(ignored.folder, Some(GitState::Ignored));

        let outside = tempfile::tempdir().unwrap();
        assert!(status_of(outside.path()).unwrap().is_none());
    }

    /// `OX_BENCH_DIR=/repo/sub cargo test --release --lib bench_git -- --ignored --nocapture`
    #[test]
    #[ignore = "manual benchmark"]
    fn bench_git() {
        let dir = std::env::var("OX_BENCH_DIR").map_or_else(|_| ".".into(), std::path::PathBuf::from);
        let started = std::time::Instant::now();
        let s = status_of(&dir).unwrap();
        println!("{:?} in {:?}", s.map(|s| (s.branch, s.children.len(), s.partial)), started.elapsed());
    }
}
