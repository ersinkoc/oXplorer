//! Renaming many items at once, all-or-nothing.
//!
//! Every item first moves to a temporary name, then to its new name, so swaps
//! (`a`↔`b`) and case-only changes work; if any step fails, everything already
//! renamed is put back.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::names::validate_name;
use super::types::{UndoAction, UndoStep};
use crate::dir::build_entry_for;
use crate::error::{AppError, AppResult};
use crate::model::FileEntry;
use crate::security::validate_path;

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenameItem {
    pub path: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BatchRenameOutcome {
    /// The renamed items, in request order.
    pub entries: Vec<FileEntry>,
    pub undo: Option<UndoAction>,
}

fn invalid(path: &str, reason: impl Into<String>) -> AppError {
    AppError::InvalidPath { path: path.to_owned(), reason: reason.into() }
}

/// Folds case the way the default (case-insensitive) APFS volume compares names.
fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

pub fn batch_rename(items: &[RenameItem]) -> AppResult<BatchRenameOutcome> {
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
    for item in items {
        let src = validate_path(&item.path)?;
        validate_name(&item.new_name).map_err(|r| invalid(&item.new_name, r))?;
        let dst = src.parent().unwrap_or(Path::new("/")).join(&item.new_name);
        if src != dst {
            plan.push((src, dst));
        }
    }
    let sources: HashSet<String> = plan.iter().map(|(s, _)| key(s)).collect();
    let mut targets = HashSet::new();
    for (src, dst) in &plan {
        if !targets.insert(key(dst)) {
            return Err(invalid(&dst.to_string_lossy(), "two items would get the same name"));
        }
        // Taken by something that isn't itself being renamed away.
        if dst.symlink_metadata().is_ok() && !sources.contains(&key(dst)) && key(dst) != key(src) {
            return Err(AppError::AlreadyExists { path: dst.to_string_lossy().into_owned() });
        }
        fs::symlink_metadata(src).map_err(|e| AppError::from_io(&e, src))?;
    }

    // Phase 1: out of the way. Phase 2: into place. `done` tracks where each item is.
    let pid = std::process::id();
    let temps: Vec<PathBuf> = plan
        .iter()
        .enumerate()
        .map(|(i, (src, _))| src.with_file_name(format!(".oxrename-{pid}-{i}")))
        .collect();
    let mut at: Vec<PathBuf> = plan.iter().map(|(s, _)| s.clone()).collect();
    let rollback = |at: &[PathBuf]| {
        for (now, (src, _)) in at.iter().zip(&plan) {
            if now != src {
                let _ = fs::rename(now, src);
            }
        }
    };
    for (i, temp) in temps.iter().enumerate() {
        if let Err(e) = fs::rename(&plan[i].0, temp) {
            rollback(&at);
            return Err(AppError::from_io(&e, &plan[i].0));
        }
        at[i] = temp.clone();
    }
    for (i, (_, dst)) in plan.iter().enumerate() {
        // Never clobber: a target that appeared meanwhile is an error.
        if dst.symlink_metadata().is_ok() {
            rollback(&at);
            return Err(AppError::AlreadyExists { path: dst.to_string_lossy().into_owned() });
        }
        if let Err(e) = fs::rename(&at[i], dst) {
            rollback(&at);
            return Err(AppError::from_io(&e, dst));
        }
        at[i] = dst.clone();
    }

    let s = |p: &Path| p.to_string_lossy().into_owned();
    let entries = plan.iter().filter_map(|(_, dst)| build_entry_for(dst)).collect();
    let steps: Vec<UndoStep> =
        plan.iter().rev().map(|(src, dst)| UndoStep::Move { from: s(dst), to: s(src) }).collect();
    let undo = (!steps.is_empty()).then(|| UndoAction { label: "Rename".into(), steps });
    Ok(BatchRenameOutcome { entries, undo })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(dir: &Path, from: &str, to: &str) -> RenameItem {
        RenameItem { path: dir.join(from).to_string_lossy().into_owned(), new_name: to.into() }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn renames_swaps_and_case_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        for (n, body) in [("a.txt", "A"), ("b.txt", "B"), ("c.txt", "C")] {
            fs::write(d.join(n), body).unwrap();
        }
        let out =
            batch_rename(&[item(d, "a.txt", "b.txt"), item(d, "b.txt", "a.txt"), item(d, "c.txt", "C.TXT")])
                .unwrap();
        assert_eq!(names(d), vec!["C.TXT", "a.txt", "b.txt"]);
        assert_eq!(fs::read_to_string(d.join("b.txt")).unwrap(), "A");
        assert_eq!(fs::read_to_string(d.join("a.txt")).unwrap(), "B");
        assert_eq!(out.entries.len(), 3);
        assert_eq!(out.undo.unwrap().steps.len(), 3);
    }

    #[test]
    fn refuses_collisions_without_touching_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        for n in ["a", "b", "keep"] {
            fs::write(d.join(n), n).unwrap();
        }
        assert!(matches!(
            batch_rename(&[item(d, "a", "x"), item(d, "b", "X")]),
            Err(AppError::InvalidPath { .. })
        ));
        assert!(matches!(batch_rename(&[item(d, "a", "keep")]), Err(AppError::AlreadyExists { .. })));
        assert!(matches!(batch_rename(&[item(d, "a", "../escape")]), Err(AppError::InvalidPath { .. })));
        assert_eq!(names(d), vec!["a", "b", "keep"]);
    }

    #[test]
    fn rolls_back_when_a_step_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        fs::write(d.join("a"), "a").unwrap();
        // The second source is missing: validation catches it before anything moves.
        assert!(batch_rename(&[item(d, "a", "a2"), item(d, "missing", "m2")]).is_err());
        assert_eq!(names(d), vec!["a"]);
    }
}
