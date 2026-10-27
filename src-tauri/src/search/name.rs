//! Search by file name across a folder tree (parallel walk).

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;

use globset::{GlobBuilder, GlobMatcher};
use ignore::{WalkBuilder, WalkState};
use unicode_normalization::UnicodeNormalization as _;

use super::{Control, Hit};
use crate::dir::is_package_path;
use crate::error::{AppError, AppResult};

pub enum NameMatcher {
    Glob(GlobMatcher),
    /// Case-folded (unless case-sensitive), NFC-normalized needle.
    Substring {
        needle: String,
        case_sensitive: bool,
    },
}

/// macOS file names may be decomposed (NFD) while typed text is composed (NFC).
fn fold(s: &str, case_sensitive: bool) -> String {
    let nfc: String = s.nfc().collect();
    if case_sensitive { nfc } else { nfc.to_lowercase() }
}

impl NameMatcher {
    pub fn new(query: &str, case_sensitive: bool) -> AppResult<Self> {
        let query = query.trim();
        if query.contains(['*', '?', '[', '{']) {
            let glob = GlobBuilder::new(&query.nfc().collect::<String>())
                .case_insensitive(!case_sensitive)
                .literal_separator(true)
                .build()
                .map_err(|e| AppError::InvalidQuery { message: e.to_string() })?;
            Ok(Self::Glob(glob.compile_matcher()))
        } else {
            Ok(Self::Substring { needle: fold(query, case_sensitive), case_sensitive })
        }
    }

    pub fn is_match(&self, name: &str) -> bool {
        match self {
            Self::Glob(g) => g.is_match(name.nfc().collect::<String>()),
            Self::Substring { needle, case_sensitive } => {
                fold(name, *case_sensitive).contains(needle.as_str())
            }
        }
    }
}

pub fn search(root: &Path, matcher: &NameMatcher, include_hidden: bool, control: &Control, tx: &Sender<Hit>) {
    // Like Finder (and unlike ripgrep): .gitignore'd files are still files.
    let walker = WalkBuilder::new(root)
        .standard_filters(false)
        .hidden(!include_hidden)
        .follow_links(false)
        .threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8)))
        .build_parallel();
    walker.run(|| {
        let tx = tx.clone();
        Box::new(move |entry| {
            if control.cancelled() {
                return WalkState::Quit;
            }
            let Ok(entry) = entry else { return WalkState::Continue };
            if entry.depth() == 0 {
                return WalkState::Continue;
            }
            control.scanned.fetch_add(1, Ordering::Relaxed);
            let path = entry.path();
            let name = entry.file_name().to_string_lossy();
            if matcher.is_match(&name) && tx.send(Hit { path: path.to_path_buf(), matched: None }).is_err() {
                return WalkState::Quit;
            }
            // An app or bundle is one item, as in Finder: don't list its insides.
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            if is_dir && is_package_path(path) { WalkState::Skip } else { WalkState::Continue }
        })
    });
}
