//! Search inside files with ripgrep's engine: `.gitignore` respected, binary
//! files skipped, the first matching line of each file reported.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;

use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::{WalkBuilder, WalkState};

use super::{Control, Hit, snippet};
use crate::dir::is_package_path;
use crate::error::{AppError, AppResult};

/// Larger files are skipped (disk images, databases, videos).
const MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;

pub fn matcher(query: &str, case_sensitive: bool, regex: bool) -> AppResult<RegexMatcher> {
    RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .fixed_strings(!regex)
        .build(query)
        .map_err(|e| AppError::InvalidQuery { message: e.to_string() })
}

/// File reads that fail once the search is cancelled, so a large file stops
/// mid-way instead of being read to the end.
struct CancellableFile<'a> {
    file: std::fs::File,
    control: &'a Control,
}

impl std::io::Read for CancellableFile<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.control.cancelled() {
            return Err(std::io::Error::other("search cancelled"));
        }
        self.file.read(buf)
    }
}

/// First matching line of `path`, if any (binary files never match).
pub fn first_match(matcher: &RegexMatcher, path: &Path, control: &Control) -> Option<(u32, String)> {
    let mut searcher =
        SearcherBuilder::new().binary_detection(BinaryDetection::quit(0)).line_number(true).build();
    let mut found = None;
    let sink = Lossy(|line, text| {
        found = Some((u32::try_from(line).unwrap_or(u32::MAX), snippet(text)));
        Ok(false)
    });
    let file = std::fs::File::open(path).ok()?;
    searcher.search_reader(matcher, CancellableFile { file, control }, sink).ok()?;
    found
}

pub fn search(
    root: &Path,
    matcher: &RegexMatcher,
    include_hidden: bool,
    control: &Control,
    tx: &Sender<Hit>,
) {
    let walker = WalkBuilder::new(root)
        .hidden(!include_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // Outside a repository a .gitignore still means "not interesting".
        .require_git(false)
        .follow_links(false)
        .max_filesize(Some(MAX_FILE_SIZE))
        .threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8)))
        .build_parallel();
    walker.run(|| {
        let tx = tx.clone();
        Box::new(move |entry| {
            if control.cancelled() {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            let Some(ft) = entry.file_type() else { return WalkState::Continue };
            if ft.is_dir() {
                return if entry.depth() > 0 && is_package_path(entry.path()) {
                    WalkState::Skip
                } else {
                    WalkState::Continue
                };
            }
            if !ft.is_file() {
                return WalkState::Continue;
            }
            control.scanned.fetch_add(1, Ordering::Relaxed);
            if let Some(found) = first_match(matcher, entry.path(), control)
                && tx.send(Hit { path: entry.path().to_path_buf(), matched: Some(found) }).is_err()
            {
                return WalkState::Quit;
            }
            WalkState::Continue
        })
    });
}
