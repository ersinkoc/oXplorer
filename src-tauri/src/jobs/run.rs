//! Executes a `JobSpec`. Independent of Tauri: the caller supplies a `Reporter`
//! for progress, conflict prompts and cancellation, which keeps this testable.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::archive;
use super::fsops;
use super::names;
use super::types::{
    ConflictChoice, ConflictResolution, JobFailure, JobOutcome, JobSpec, UndoAction, UndoStep,
};
use crate::dir::build_entry_for;
use crate::error::AppError;
use crate::security::{is_protected_root, validate_path};

pub trait Reporter {
    fn planned(&mut self, total_bytes: u64, total_items: u32);
    /// Called often; implementations throttle.
    fn progress(&mut self, done_bytes: u64, done_items: u32, current: &Path);
    /// Blocks until the user decides.
    fn conflict(&mut self, source: &Path, existing: &Path) -> ConflictResolution;
    fn cancelled(&self) -> bool;
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Copy,
    Move,
}

/// What actually happened, recorded as we go so a partial job is still undoable.
enum Done {
    Created(PathBuf),
    Moved {
        from: PathBuf,
        to: PathBuf,
    },
    Trashed {
        from: PathBuf,
        to: PathBuf,
    },
    /// Tags were replaced; `before` restores them.
    Tagged {
        path: PathBuf,
        before: Vec<crate::model::FinderTag>,
    },
}

struct Runner<'a> {
    r: &'a mut dyn Reporter,
    done_bytes: u64,
    done_items: u32,
    policy: Option<ConflictChoice>,
    /// "Apply to all" with Merge: later folder clashes merge, file clashes still ask.
    merge_all: bool,
    log: Vec<Done>,
    removed: Vec<PathBuf>,
    failures: Vec<JobFailure>,
    skipped: u32,
    stopped: bool,
}

pub fn run(spec: JobSpec, reporter: &mut dyn Reporter) -> Result<JobOutcome, AppError> {
    let mut job = Runner {
        r: reporter,
        done_bytes: 0,
        done_items: 0,
        policy: None,
        merge_all: false,
        log: Vec::new(),
        removed: Vec::new(),
        failures: Vec::new(),
        skipped: 0,
        stopped: false,
    };
    let label = match &spec {
        JobSpec::Copy { .. } => "Copy",
        JobSpec::Move { .. } => "Move",
        JobSpec::Duplicate { .. } => "Duplicate",
        JobSpec::Trash { .. } => "Move to Trash",
        JobSpec::Delete { .. } => "Delete",
        JobSpec::Compress { .. } => "Compress",
        JobSpec::Extract { .. } => "Extract",
        JobSpec::ExtractMembers { .. } | JobSpec::Download { .. } | JobSpec::Upload { .. } => "Copy",
        JobSpec::Sync { .. } => "Synchronize",
        JobSpec::Undo { action } => action.label.as_str(),
    }
    .to_owned();

    match spec {
        JobSpec::Copy { sources, dest_dir } => job.transfer(pairs(&sources, &dest_dir)?, Mode::Copy),
        JobSpec::Move { sources, dest_dir } => job.transfer(pairs(&sources, &dest_dir)?, Mode::Move),
        JobSpec::Duplicate { sources } => {
            let items = sources
                .iter()
                .map(|s| {
                    let src = validate_path(s)?;
                    let parent = src.parent().unwrap_or(Path::new("/")).to_path_buf();
                    Ok((src, parent))
                })
                .collect::<Result<Vec<_>, AppError>>()?;
            let pairs = items
                .into_iter()
                .map(|(src, parent)| {
                    let dst = names::duplicate(&parent, &file_name(&src), has_extension(&src));
                    (src, dst)
                })
                .collect();
            job.transfer(pairs, Mode::Copy);
        }
        JobSpec::Trash { paths } => job.trash(validate_all(&paths)?),
        JobSpec::Delete { paths } => job.delete(validate_all(&paths)?),
        JobSpec::Compress { sources, format, password } => {
            job.compress(validate_all(&sources)?, format, password.as_ref().map(|p| p.0.as_str()))?;
        }
        JobSpec::Extract { archives, password } => {
            job.extract(validate_all(&archives)?, password.as_ref().map(|p| p.0.as_str()));
        }
        JobSpec::Download { sources, dest_dir } => job.download(&sources, &validate_path(&dest_dir)?),
        JobSpec::Upload { sources, dest_dir } => job.upload(&validate_all(&sources)?, &dest_dir),
        JobSpec::ExtractMembers { sources, dest_dir } => {
            job.extract_members(&sources, &validate_path(&dest_dir)?)?;
        }
        JobSpec::Sync { items } => {
            let pairs = items
                .iter()
                .map(|i| Ok((validate_path(&i.source)?, validate_path(&i.dest)?)))
                .collect::<Result<Vec<_>, AppError>>()?;
            // The user already chose which side wins.
            job.policy = Some(ConflictChoice::Replace);
            job.transfer(pairs, Mode::Copy);
        }
        JobSpec::Undo { action } => job.undo(action.steps)?,
    }
    Ok(job.finish(label))
}

fn validate_all(paths: &[String]) -> Result<Vec<PathBuf>, AppError> {
    paths.iter().map(|p| validate_path(p)).collect()
}

fn pairs(sources: &[String], dest_dir: &str) -> Result<Vec<(PathBuf, PathBuf)>, AppError> {
    let dest = validate_path(dest_dir)?;
    validate_all(sources)?
        .into_iter()
        .map(|src| {
            let name = src.file_name().ok_or_else(|| AppError::InvalidPath {
                path: src.to_string_lossy().into_owned(),
                reason: "has no name".into(),
            })?;
            let dst = dest.join(name);
            Ok((src, dst))
        })
        .collect()
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Files and packages keep their extension at the end when renamed; folders don't.
fn has_extension(p: &Path) -> bool {
    fs::symlink_metadata(p).map_or(true, |m| !m.is_dir() || is_package(p))
}

fn is_package(p: &Path) -> bool {
    matches!(build_entry_for(p).map(|e| e.kind), Some(crate::model::EntryKind::Package))
}

fn err(path: &Path, e: &io::Error) -> JobFailure {
    JobFailure { path: path.to_string_lossy().into_owned(), error: AppError::from_io(e, path) }
}

/// Bytes and item count of a tree, without following symlinks.
fn tree_size(p: &Path) -> (u64, u32) {
    let Ok(meta) = fs::symlink_metadata(p) else { return (0, 0) };
    if meta.file_type().is_symlink() {
        // The link itself is copied, never its target.
        return (0, 1);
    }
    if !meta.is_dir() {
        return (meta.len(), 1);
    }
    let mut total = (0, 1);
    if let Ok(read) = fs::read_dir(p) {
        for e in read.flatten() {
            let (b, n) = tree_size(&e.path());
            total.0 += b;
            total.1 += n;
        }
    }
    total
}

impl Runner<'_> {
    fn tick(&mut self, bytes: u64, items: u32, current: &Path) {
        self.done_bytes += bytes;
        self.done_items += items;
        self.r.progress(self.done_bytes, self.done_items, current);
    }

    fn should_stop(&mut self) -> bool {
        if self.r.cancelled() {
            self.stopped = true;
        }
        self.stopped
    }

    fn transfer(&mut self, pairs: Vec<(PathBuf, PathBuf)>, mode: Mode) {
        let sizes: Vec<(u64, u32)> = pairs.iter().map(|(s, _)| tree_size(s)).collect();
        self.r.planned(sizes.iter().map(|s| s.0).sum(), sizes.iter().map(|s| s.1).sum());

        for ((src, dst), (bytes, items)) in pairs.into_iter().zip(sizes) {
            if self.should_stop() {
                break;
            }
            let before = (self.done_bytes, self.done_items);
            match self.transfer_one(&src, dst, mode) {
                Ok(true) => {}
                Ok(false) => self.skipped += 1,
                Err(f) => self.failures.push(f),
            }
            if self.stopped {
                break;
            }
            // Re-sync the counters with the plan so skipped/failed items still advance the bar.
            self.done_bytes = before.0 + bytes;
            self.done_items = before.1 + items;
            self.r.progress(self.done_bytes, self.done_items, &src);
        }
    }

    /// `Ok(false)` = skipped.
    fn transfer_one(&mut self, src: &Path, mut dst: PathBuf, mode: Mode) -> Result<bool, JobFailure> {
        let meta = fs::symlink_metadata(src).map_err(|e| err(src, &e))?;
        if src == dst {
            if mode == Mode::Move {
                return Ok(false);
            }
            // Pasting into the same folder makes a copy, like Finder.
            dst =
                names::duplicate(dst.parent().unwrap_or(Path::new("/")), &file_name(src), has_extension(src));
        }
        if meta.is_dir() && dst.starts_with(src) {
            return Err(JobFailure {
                path: src.to_string_lossy().into_owned(),
                error: AppError::InvalidPath {
                    path: dst.to_string_lossy().into_owned(),
                    reason: "a folder can’t be copied or moved into itself".into(),
                },
            });
        }

        if let Ok(existing) = dst.symlink_metadata() {
            // Packages (.app, .pages) are replaced or kept whole, never mixed.
            let folders = meta.is_dir() && existing.is_dir() && !is_package(src) && !is_package(&dst);
            let choice = match self.policy {
                _ if folders && self.merge_all => ConflictChoice::Merge,
                Some(c) => c,
                None => {
                    let res = self.r.conflict(src, &dst);
                    if res.apply_to_all {
                        if res.choice == ConflictChoice::Merge {
                            self.merge_all = true;
                        } else {
                            self.policy = Some(res.choice);
                        }
                    }
                    res.choice
                }
            };
            match choice {
                ConflictChoice::Merge if folders => return self.merge(src, &dst, mode),
                // Merge only applies to folders; anything else keeps both.
                ConflictChoice::Merge => {
                    dst = names::keep_both(
                        dst.parent().unwrap_or(Path::new("/")),
                        &file_name(&dst),
                        has_extension(src),
                    );
                }
                ConflictChoice::Skip => return Ok(false),
                ConflictChoice::Stop => {
                    self.stopped = true;
                    return Ok(false);
                }
                ConflictChoice::KeepBoth => {
                    dst = names::keep_both(
                        dst.parent().unwrap_or(Path::new("/")),
                        &file_name(&dst),
                        has_extension(src),
                    );
                }
                ConflictChoice::Replace => {
                    // The replaced item goes to the Trash so undo can bring it back.
                    let to = fsops::trash(&dst).map_err(|e| err(&dst, &e))?;
                    self.log.push(Done::Trashed { from: dst.clone(), to });
                }
            }
        }

        if mode == Mode::Move && fsops::same_device(src, dst.parent().unwrap_or(Path::new("/"))) {
            fs::rename(src, &dst).map_err(|e| err(src, &e))?;
            self.log.push(Done::Moved { from: src.to_path_buf(), to: dst });
            self.removed.push(src.to_path_buf());
            return Ok(true);
        }

        match self.copy_tree(src, &dst) {
            Ok(()) => {}
            Err(e) => {
                // Never leave a half-copied tree behind.
                let _ = fsops::remove(&dst);
                if self.stopped {
                    return Ok(false);
                }
                return Err(e);
            }
        }
        if mode == Mode::Move {
            fsops::remove(src).map_err(|e| err(src, &e))?;
            self.log.push(Done::Moved { from: src.to_path_buf(), to: dst });
            self.removed.push(src.to_path_buf());
        } else {
            self.log.push(Done::Created(dst));
        }
        Ok(true)
    }

    /// Folder onto an existing folder: each item goes in (clashes inside are asked
    /// about again); a moved folder that ends up empty is removed.
    fn merge(&mut self, src: &Path, dst: &Path, mode: Mode) -> Result<bool, JobFailure> {
        let children: Vec<PathBuf> =
            fs::read_dir(src).map_err(|e| err(src, &e))?.flatten().map(|e| e.path()).collect();
        let (mut all, mut any) = (true, false);
        for child in children {
            if self.should_stop() {
                all = false;
                break;
            }
            match self.transfer_one(&child, dst.join(child.file_name().unwrap_or_default()), mode) {
                Ok(true) => any = true,
                Ok(false) => all = false,
                Err(f) => {
                    all = false;
                    self.failures.push(f);
                }
            }
        }
        // Empty now; undo recreates it when moving the items back.
        if mode == Mode::Move && all && fs::remove_dir(src).is_ok() {
            self.removed.push(src.to_path_buf());
        }
        // Counts as skipped only if nothing went in.
        Ok(any || all)
    }

    fn copy_tree(&mut self, src: &Path, dst: &Path) -> Result<(), JobFailure> {
        if self.should_stop() {
            return Err(err(src, &io::Error::from(io::ErrorKind::Interrupted)));
        }
        let meta = fs::symlink_metadata(src).map_err(|e| err(src, &e))?;
        if meta.is_dir() {
            fs::create_dir(dst).map_err(|e| err(dst, &e))?;
            let children: Vec<PathBuf> =
                fs::read_dir(src).map_err(|e| err(src, &e))?.flatten().map(|e| e.path()).collect();
            for child in children {
                self.copy_tree(&child, &dst.join(child.file_name().unwrap_or_default()))?;
            }
            fsops::copy_dir_metadata(src, dst).map_err(|e| err(dst, &e))?;
            self.tick(0, 1, src);
        } else if meta.file_type().is_symlink() {
            let target = fs::read_link(src).map_err(|e| err(src, &e))?;
            std::os::unix::fs::symlink(target, dst).map_err(|e| err(dst, &e))?;
            self.tick(0, 1, src);
        } else {
            let (base, items) = (self.done_bytes, self.done_items);
            let r = &mut *self.r;
            let result = fsops::copy_file(src, dst, &mut |copied| {
                r.progress(base + copied, items, src);
                !r.cancelled()
            });
            if let Err(e) = result {
                if self.r.cancelled() {
                    self.stopped = true;
                }
                return Err(err(src, &e));
            }
            self.tick(meta.len(), 1, src);
        }
        Ok(())
    }

    fn trash(&mut self, paths: Vec<PathBuf>) {
        self.r.planned(0, u32::try_from(paths.len()).unwrap_or(u32::MAX));
        for p in paths {
            if self.should_stop() {
                break;
            }
            match fsops::trash(&p) {
                Ok(to) => {
                    self.log.push(Done::Trashed { from: p.clone(), to });
                    self.removed.push(p.clone());
                }
                Err(e) => self.failures.push(err(&p, &e)),
            }
            self.tick(0, 1, &p);
        }
    }

    fn delete(&mut self, paths: Vec<PathBuf>) {
        self.r.planned(0, u32::try_from(paths.len()).unwrap_or(u32::MAX));
        for p in paths {
            if self.should_stop() {
                break;
            }
            if is_protected_root(&p) {
                self.failures.push(JobFailure {
                    path: p.to_string_lossy().into_owned(),
                    error: AppError::InvalidPath {
                        path: p.to_string_lossy().into_owned(),
                        reason: "system folders can’t be deleted".into(),
                    },
                });
                continue;
            }
            match fsops::remove(&p) {
                Ok(()) => self.removed.push(p.clone()),
                Err(e) => self.failures.push(err(&p, &e)),
            }
            self.tick(0, 1, &p);
        }
    }

    fn undo(&mut self, steps: Vec<UndoStep>) -> Result<(), AppError> {
        self.r.planned(0, u32::try_from(steps.len()).unwrap_or(u32::MAX));
        // Items a failed move-back left where they were; their folder must not go to the Trash.
        let mut stranded: Vec<PathBuf> = Vec::new();
        for step in steps {
            if self.should_stop() {
                break;
            }
            match step {
                UndoStep::Trash { path } => {
                    let p = validate_path(&path)?;
                    if stranded.iter().any(|s| s.starts_with(&p)) {
                        self.tick(0, 1, &p);
                        continue;
                    }
                    match fsops::trash(&p) {
                        Ok(to) => {
                            self.log.push(Done::Trashed { from: p.clone(), to });
                            self.removed.push(p.clone());
                        }
                        Err(e) => self.failures.push(err(&p, &e)),
                    }
                    self.tick(0, 1, &p);
                }
                UndoStep::Tags { path, tags } => {
                    let p = validate_path(&path)?;
                    let before = crate::mac::tags::read_tags(&p);
                    match crate::mac::tags::write_tags(&p, &tags) {
                        Ok(()) => self.log.push(Done::Tagged { path: p.clone(), before }),
                        Err(e) => self.failures.push(err(&p, &e)),
                    }
                    self.tick(0, 1, &p);
                }
                UndoStep::Move { from, to } => {
                    let (from, to) = (validate_path(&from)?, validate_path(&to)?);
                    if to.symlink_metadata().is_ok() {
                        // Something new took the old place; don't clobber it.
                        self.failures.push(err(&to, &io::Error::from(io::ErrorKind::AlreadyExists)));
                        stranded.push(from);
                        continue;
                    }
                    let parent = to.parent().unwrap_or(Path::new("/")).to_path_buf();
                    // A merged folder was removed once empty; bring it back for its items.
                    if let Err(e) = fs::create_dir_all(&parent) {
                        self.failures.push(err(&parent, &e));
                        stranded.push(from);
                        continue;
                    }
                    let result = if fsops::same_device(&from, &parent) {
                        fs::rename(&from, &to)
                    } else {
                        let r = self.copy_tree(&from, &to).map_err(|_| io::Error::other("copy failed"));
                        r.and_then(|()| fsops::remove(&from))
                    };
                    match result {
                        Ok(()) => {
                            self.log.push(Done::Moved { from: from.clone(), to });
                            self.removed.push(from);
                        }
                        Err(e) => {
                            self.failures.push(err(&from, &e));
                            stranded.push(from);
                        }
                    }
                    self.tick(0, 1, &parent);
                }
            }
        }
        Ok(())
    }

    /// Archive work reports bytes; a cancel surfaces as `Interrupted`.
    fn archive_result<T>(&mut self, path: &Path, result: io::Result<T>) -> Option<T> {
        match result {
            Ok(v) => Some(v),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {
                self.stopped = true;
                None
            }
            Err(e) => {
                self.failures.push(err(path, &e));
                None
            }
        }
    }

    fn compress(
        &mut self,
        sources: Vec<PathBuf>,
        format: archive::ArchiveFormat,
        password: Option<&str>,
    ) -> Result<(), AppError> {
        let parent = sources.first().and_then(|s| s.parent()).map(Path::to_path_buf);
        if sources.iter().any(|s| s.parent().map(Path::to_path_buf) != parent) {
            return Err(AppError::InvalidPath {
                path: sources.first().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                reason: "items to compress must be in the same folder".into(),
            });
        }
        let Some(dest) = archive::archive_path(&sources, format) else { return Ok(()) };
        let sizes: Vec<(u64, u32)> = sources.iter().map(|s| tree_size(s)).collect();
        self.r.planned(sizes.iter().map(|s| s.0).sum(), 1);
        let result = {
            let r = &mut *self.r;
            let mut done = 0;
            archive::compress(&sources, &dest, format, password, &mut |n| {
                done += n;
                r.progress(done, 0, &dest);
                !r.cancelled()
            })
        };
        if self.archive_result(&dest, result).is_some() {
            self.log.push(Done::Created(dest));
        }
        Ok(())
    }

    fn extract(&mut self, archives: Vec<PathBuf>, password: Option<&str>) {
        let units: Vec<u64> = archives.iter().map(|a| archive::work_units(a)).collect();
        self.r.planned(units.iter().sum(), u32::try_from(archives.len()).unwrap_or(u32::MAX));
        for (archive, total) in archives.iter().zip(units) {
            if self.should_stop() {
                break;
            }
            let before = self.done_bytes;
            let result = {
                let r = &mut *self.r;
                let mut done = before;
                archive::extract(archive, password, &mut |n| {
                    done += n;
                    r.progress(done, 0, archive);
                    !r.cancelled()
                })
            };
            if let Some(out) = self.archive_result(archive, result) {
                self.log.push(Done::Created(out));
            }
            if self.stopped {
                break;
            }
            self.done_bytes = before + total;
            self.done_items += 1;
            self.r.progress(self.done_bytes, self.done_items, archive);
        }
    }

    fn transfer_result<T>(
        &mut self,
        path: &str,
        result: Result<T, crate::remote::TransferError>,
    ) -> Option<T> {
        match result {
            Ok(v) => Some(v),
            Err(crate::remote::TransferError::Cancelled) => {
                self.stopped = true;
                None
            }
            Err(e) => {
                self.failures.push(JobFailure { path: path.to_owned(), error: e.into_app(path) });
                None
            }
        }
    }

    fn download(&mut self, sources: &[String], dest: &Path) {
        let total = tauri::async_runtime::block_on(crate::remote::remote_size(sources));
        self.r.planned(total, u32::try_from(sources.len()).unwrap_or(u32::MAX));
        let result = {
            let r = &mut *self.r;
            let mut done = 0;
            tauri::async_runtime::block_on(crate::remote::download(sources, dest, &mut |n| {
                done += n;
                r.progress(done, 0, dest);
                !r.cancelled()
            }))
        };
        let first = sources.first().cloned().unwrap_or_default();
        if let Some(created) = self.transfer_result(&first, result) {
            self.log.extend(created.into_iter().map(Done::Created));
        }
    }

    /// Servers have no Trash, so uploads can't be undone; the pane re-lists the folder.
    fn upload(&mut self, sources: &[PathBuf], dest: &str) {
        let sizes: Vec<(u64, u32)> = sources.iter().map(|s| tree_size(s)).collect();
        self.r.planned(sizes.iter().map(|s| s.0).sum(), sizes.iter().map(|s| s.1).sum());
        let result = {
            let r = &mut *self.r;
            let mut done = 0;
            let here = PathBuf::from(dest);
            tauri::async_runtime::block_on(crate::remote::upload(sources, dest, &mut |n| {
                done += n;
                r.progress(done, 0, &here);
                !r.cancelled()
            }))
        };
        let _ = self.transfer_result(dest, result);
    }

    fn extract_members(&mut self, sources: &[String], dest: &Path) -> Result<(), AppError> {
        let parsed = sources.iter().map(|s| crate::archive_fs::parse(s)).collect::<Result<Vec<_>, _>>()?;
        let Some((archive, _)) = parsed.first() else { return Ok(()) };
        if parsed.iter().any(|(a, _)| a != archive) {
            return Err(AppError::InvalidPath {
                path: sources.first().cloned().unwrap_or_default(),
                reason: "items must come from one archive".into(),
            });
        }
        let inners: Vec<String> = parsed.iter().map(|(_, i)| i.clone()).collect();
        let total = archive::work_units(archive);
        self.r.planned(total, u32::try_from(inners.len()).unwrap_or(u32::MAX));
        let result = {
            let r = &mut *self.r;
            let mut done = 0;
            archive::extract_members(archive, &inners, dest, &mut |n| {
                done += n;
                r.progress(done, 0, archive);
                !r.cancelled()
            })
        };
        if let Some(created) = self.archive_result(archive, result) {
            self.log.extend(created.into_iter().map(Done::Created));
        }
        Ok(())
    }

    fn finish(self, label: String) -> JobOutcome {
        let s = |p: &Path| p.to_string_lossy().into_owned();
        // Undo replays the log backwards.
        let steps: Vec<UndoStep> = self
            .log
            .iter()
            .rev()
            .map(|d| match d {
                Done::Created(p) => UndoStep::Trash { path: s(p) },
                Done::Moved { from, to } | Done::Trashed { from, to } => {
                    UndoStep::Move { from: s(to), to: s(from) }
                }
                Done::Tagged { path, before } => UndoStep::Tags { path: s(path), tags: before.clone() },
            })
            .collect();
        let created = self
            .log
            .iter()
            .filter_map(|d| match d {
                Done::Created(p) | Done::Moved { to: p, .. } | Done::Tagged { path: p, .. } => {
                    build_entry_for(p)
                }
                Done::Trashed { .. } => None,
            })
            .collect();
        JobOutcome {
            created,
            removed: self.removed.iter().map(|p| s(p)).collect(),
            undo: (!steps.is_empty()).then_some(UndoAction { label, steps }),
            failures: self.failures,
            skipped: self.skipped,
            cancelled: self.stopped,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Fake {
        answer: ConflictResolution,
        conflicts: u32,
        cancel_after_bytes: Option<u64>,
        cancelled: AtomicBool,
        last: (u64, u32),
        planned: (u64, u32),
    }

    impl Fake {
        fn new(choice: ConflictChoice) -> Self {
            Self {
                answer: ConflictResolution { choice, apply_to_all: false },
                conflicts: 0,
                cancel_after_bytes: None,
                cancelled: AtomicBool::new(false),
                last: (0, 0),
                planned: (0, 0),
            }
        }
    }

    impl Reporter for Fake {
        fn planned(&mut self, b: u64, n: u32) {
            self.planned = (b, n);
        }
        fn progress(&mut self, b: u64, n: u32, _: &Path) {
            self.last = (b, n);
            if self.cancel_after_bytes.is_some_and(|limit| b >= limit) {
                self.cancelled.store(true, Ordering::SeqCst);
            }
        }
        fn conflict(&mut self, _: &Path, _: &Path) -> ConflictResolution {
            self.conflicts += 1;
            self.answer
        }
        fn cancelled(&self) -> bool {
            self.cancelled.load(Ordering::SeqCst)
        }
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn tree(root: &Path) {
        fs::create_dir_all(root.join("src/sub")).unwrap();
        fs::write(root.join("src/a.txt"), "aaaa").unwrap();
        fs::write(root.join("src/sub/b.txt"), "bb").unwrap();
        std::os::unix::fs::symlink("a.txt", root.join("src/link")).unwrap();
        fs::create_dir(root.join("dest")).unwrap();
    }

    #[test]
    fn undo_keeps_a_folder_whose_items_could_not_move_back() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir(root.join("box")).unwrap();
        fs::write(root.join("box/a.txt"), b"old").unwrap();
        // A new a.txt took the old place, so the move back fails.
        fs::write(root.join("a.txt"), b"new").unwrap();
        let action = UndoAction {
            label: "New Folder with Selection".into(),
            steps: vec![
                UndoStep::Move { from: s(&root.join("box/a.txt")), to: s(&root.join("a.txt")) },
                UndoStep::Trash { path: s(&root.join("box")) },
            ],
        };
        let out = run(JobSpec::Undo { action }, &mut Fake::new(ConflictChoice::Skip)).unwrap();
        assert_eq!(out.failures.len(), 1);
        assert_eq!(fs::read(root.join("box/a.txt")).unwrap(), b"old");
    }

    #[test]
    fn merge_never_mixes_packages() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(root.join("src/Thing.app/Contents")).unwrap();
        fs::create_dir_all(root.join("dest/Thing.app/Contents")).unwrap();
        fs::write(root.join("src/Thing.app/Contents/new"), b"").unwrap();
        fs::write(root.join("dest/Thing.app/Contents/old"), b"").unwrap();
        let out = run(
            JobSpec::Copy { sources: vec![s(&root.join("src/Thing.app"))], dest_dir: s(&root.join("dest")) },
            &mut Fake::new(ConflictChoice::Merge),
        )
        .unwrap();
        assert!(out.failures.is_empty(), "{:?}", out.failures);
        assert!(!root.join("dest/Thing.app/Contents/new").exists(), "bundles must not be mixed");
        assert!(root.join("dest/Thing 2.app/Contents/new").exists());
    }

    #[test]
    fn merge_moves_into_an_existing_folder_and_undoes() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(root.join("a/sub")).unwrap();
        fs::write(root.join("a/x.txt"), b"x").unwrap();
        fs::write(root.join("a/same.txt"), b"new").unwrap();
        fs::write(root.join("a/sub/y.txt"), b"y").unwrap();
        fs::create_dir_all(root.join("dest/a")).unwrap();
        fs::write(root.join("dest/a/z.txt"), b"z").unwrap();
        fs::write(root.join("dest/a/same.txt"), b"old").unwrap();

        // Merge for the folder; the file clash inside keeps both.
        let out = run(
            JobSpec::Move { sources: vec![s(&root.join("a"))], dest_dir: s(&root.join("dest")) },
            &mut Fake::new(ConflictChoice::Merge),
        )
        .unwrap();
        assert!(out.failures.is_empty(), "{:?}", out.failures);
        assert!(!root.join("a").exists(), "the emptied source folder is removed");
        for (path, body) in [("x.txt", "x"), ("z.txt", "z"), ("same.txt", "old"), ("same 2.txt", "new")] {
            assert_eq!(fs::read_to_string(root.join("dest/a").join(path)).unwrap(), body, "{path}");
        }
        assert_eq!(fs::read_to_string(root.join("dest/a/sub/y.txt")).unwrap(), "y");

        let back =
            run(JobSpec::Undo { action: out.undo.unwrap() }, &mut Fake::new(ConflictChoice::Skip)).unwrap();
        assert!(back.failures.is_empty(), "{:?}", back.failures);
        assert_eq!(fs::read_to_string(root.join("a/same.txt")).unwrap(), "new");
        assert_eq!(fs::read_to_string(root.join("a/sub/y.txt")).unwrap(), "y");
        assert_eq!(fs::read_to_string(root.join("dest/a/same.txt")).unwrap(), "old");
        assert!(!root.join("dest/a/x.txt").exists());
        assert!(root.join("dest/a/z.txt").exists());
    }

    #[test]
    fn copy_tree_then_undo_then_redo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        tree(&root);
        let mut r = Fake::new(ConflictChoice::Skip);
        let out = run(
            JobSpec::Copy { sources: vec![s(&root.join("src"))], dest_dir: s(&root.join("dest")) },
            &mut r,
        )
        .unwrap();

        assert_eq!(r.planned, (6, 5), "3 files (incl. symlink) + 2 dirs, 6 bytes");
        assert_eq!(r.last, (6, 5));
        assert_eq!(fs::read_to_string(root.join("dest/src/sub/b.txt")).unwrap(), "bb");
        assert_eq!(fs::read_link(root.join("dest/src/link")).unwrap(), Path::new("a.txt"));
        assert_eq!(out.created.len(), 1);
        assert!(out.removed.is_empty());

        // Undo trashes the copy.
        let undo = out.undo.unwrap();
        assert_eq!(undo.steps, vec![UndoStep::Trash { path: s(&root.join("dest/src")) }]);
        let back = run(JobSpec::Undo { action: undo }, &mut Fake::new(ConflictChoice::Skip)).unwrap();
        assert!(back.failures.is_empty(), "{:?}", back.failures);
        assert!(!root.join("dest/src").exists());

        // Redo = undo of the undo: the copy comes back from the Trash.
        let redo = back.undo.unwrap();
        let again = run(JobSpec::Undo { action: redo }, &mut Fake::new(ConflictChoice::Skip)).unwrap();
        assert!(again.failures.is_empty(), "{:?}", again.failures);
        assert!(root.join("dest/src/a.txt").exists());
    }

    #[test]
    fn move_and_undo() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        tree(&root);
        let out = run(
            JobSpec::Move { sources: vec![s(&root.join("src/a.txt"))], dest_dir: s(&root.join("dest")) },
            &mut Fake::new(ConflictChoice::Skip),
        )
        .unwrap();
        assert!(root.join("dest/a.txt").exists() && !root.join("src/a.txt").exists());
        assert_eq!(out.removed, vec![s(&root.join("src/a.txt"))]);

        let back =
            run(JobSpec::Undo { action: out.undo.unwrap() }, &mut Fake::new(ConflictChoice::Skip)).unwrap();
        assert!(back.failures.is_empty());
        assert!(root.join("src/a.txt").exists() && !root.join("dest/a.txt").exists());
    }

    #[test]
    fn conflicts_skip_keep_both_and_apply_to_all() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        tree(&root);
        fs::write(root.join("dest/a.txt"), "old").unwrap();
        fs::write(root.join("x.txt"), "x").unwrap();
        fs::write(root.join("dest/x.txt"), "old").unwrap();
        let sources = vec![s(&root.join("src/a.txt")), s(&root.join("x.txt"))];

        let mut r = Fake::new(ConflictChoice::Skip);
        let out =
            run(JobSpec::Copy { sources: sources.clone(), dest_dir: s(&root.join("dest")) }, &mut r).unwrap();
        assert_eq!((out.skipped, r.conflicts), (2, 2));
        assert_eq!(fs::read_to_string(root.join("dest/a.txt")).unwrap(), "old");

        let mut r = Fake::new(ConflictChoice::KeepBoth);
        r.answer.apply_to_all = true;
        run(JobSpec::Copy { sources, dest_dir: s(&root.join("dest")) }, &mut r).unwrap();
        assert_eq!(r.conflicts, 1, "apply-to-all asks once");
        assert_eq!(fs::read_to_string(root.join("dest/a 2.txt")).unwrap(), "aaaa");
        assert_eq!(fs::read_to_string(root.join("dest/x 2.txt")).unwrap(), "x");
    }

    #[test]
    fn paste_into_same_folder_duplicates_and_folder_into_itself_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        tree(&root);
        let out = run(
            JobSpec::Copy { sources: vec![s(&root.join("src/a.txt"))], dest_dir: s(&root.join("src")) },
            &mut Fake::new(ConflictChoice::Skip),
        )
        .unwrap();
        assert!(root.join("src/a copy.txt").exists());
        assert_eq!(out.created[0].name, "a copy.txt");

        let out = run(
            JobSpec::Copy { sources: vec![s(&root.join("src"))], dest_dir: s(&root.join("src/sub")) },
            &mut Fake::new(ConflictChoice::Skip),
        )
        .unwrap();
        assert_eq!(out.failures.len(), 1);
        assert!(!root.join("src/sub/src").exists());
    }

    #[test]
    fn cancel_mid_copy_leaves_no_partial_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(tmp.path()).unwrap();
        fs::create_dir_all(root.join("big")).unwrap();
        for i in 0..20 {
            fs::write(root.join(format!("big/f{i}")), vec![0u8; 64 * 1024]).unwrap();
        }
        fs::create_dir(root.join("dest")).unwrap();
        let mut r = Fake::new(ConflictChoice::Skip);
        r.cancel_after_bytes = Some(5 * 64 * 1024);
        let out = run(
            JobSpec::Copy { sources: vec![s(&root.join("big"))], dest_dir: s(&root.join("dest")) },
            &mut r,
        )
        .unwrap();
        assert!(out.cancelled);
        assert!(!root.join("dest/big").exists(), "partial copy is removed");
        assert!(out.undo.is_none());
    }

    #[test]
    fn tag_edits_undo_and_redo() {
        use crate::mac::tags::{read_tags, write_tags};
        use crate::model::FinderTag;
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("f.txt");
        fs::write(&f, "").unwrap();
        let red = FinderTag { name: "Red".into(), color: 6 };
        let work = FinderTag { name: "Work".into(), color: 0 };
        write_tags(&f, std::slice::from_ref(&work)).unwrap();
        // The edit (done by the command) recorded the tags it replaced.
        write_tags(&f, &[work.clone(), red.clone()]).unwrap();
        let undo = UndoAction {
            label: "Tags".into(),
            steps: vec![UndoStep::Tags { path: s(&f), tags: vec![work.clone()] }],
        };

        let undone = run(JobSpec::Undo { action: undo }, &mut Fake::new(ConflictChoice::Skip)).unwrap();
        assert_eq!(read_tags(&f), vec![work.clone()]);
        assert_eq!(undone.created.len(), 1, "the entry comes back with its tags for the UI");
        let redo = undone.undo.unwrap();
        run(JobSpec::Undo { action: redo }, &mut Fake::new(ConflictChoice::Skip)).unwrap();
        assert_eq!(read_tags(&f), vec![work, red]);
    }

    #[test]
    fn delete_refuses_system_roots() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("v");
        fs::write(&victim, "").unwrap();
        let out = run(
            JobSpec::Delete { paths: vec!["/System".into(), s(&victim)] },
            &mut Fake::new(ConflictChoice::Skip),
        )
        .unwrap();
        assert_eq!(out.failures.len(), 1);
        assert!(!victim.exists());
        assert!(out.undo.is_none(), "permanent delete has no undo");
    }
}

#[cfg(test)]
mod bench {
    use super::*;

    struct Count(u64, u32, std::time::Instant, Option<u64>);
    impl Reporter for Count {
        fn planned(&mut self, b: u64, n: u32) {
            eprintln!("planned {n} items / {b} bytes after {:?}", self.2.elapsed());
        }
        fn progress(&mut self, b: u64, n: u32, _: &Path) {
            (self.0, self.1) = (b, n);
        }
        fn conflict(&mut self, _: &Path, _: &Path) -> ConflictResolution {
            ConflictResolution { choice: ConflictChoice::Skip, apply_to_all: true }
        }
        fn cancelled(&self) -> bool {
            self.3.is_some_and(|after| u64::from(self.1) >= after)
        }
    }

    /// `OX_BENCH_SRC=/dir OX_BENCH_DEST=/empty cargo test --release --lib bench_copy -- --ignored --nocapture`
    #[test]
    #[ignore = "manual benchmark"]
    fn bench_copy() {
        let src = std::env::var("OX_BENCH_SRC").expect("OX_BENCH_SRC");
        let dest = std::env::var("OX_BENCH_DEST").expect("OX_BENCH_DEST");
        let cancel_after = std::env::var("OX_BENCH_CANCEL_AFTER").ok().and_then(|v| v.parse().ok());
        let mut r = Count(0, 0, std::time::Instant::now(), cancel_after);
        let out = run(JobSpec::Copy { sources: vec![src], dest_dir: dest }, &mut r).unwrap();
        eprintln!(
            "copied {} items / {} bytes in {:?}; cancelled={} failures={}",
            r.1,
            r.0,
            r.2.elapsed(),
            out.cancelled,
            out.failures.len()
        );
    }
}
