//! Recursive search, streamed to the frontend: by name, by content (ripgrep's
//! engine), or through Spotlight (`mdfind`, also used for Finder tags).

mod content;
mod name;
mod spotlight;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};
use crate::model::FileEntry;
use crate::security::validate_path;

/// More results than anyone scrolls through; the search stops there.
const MAX_RESULTS: u32 = 10_000;
const FLUSH_ITEMS: usize = 200;
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    /// File and folder names: substring, or a glob when the query has `*?[{`.
    Name,
    /// File contents, `.gitignore`-aware, binary files skipped.
    Content,
    /// A Spotlight query (plain words or `kMDItem…` syntax).
    Spotlight,
    /// Items carrying the Finder tag named by the query.
    Tag,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchSpec {
    pub scope: String,
    pub query: String,
    pub mode: SearchMode,
    pub case_sensitive: bool,
    /// Content mode: the query is a regular expression, not literal text.
    pub regex: bool,
    pub include_hidden: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    pub path: String,
    pub line: u32,
    /// The matching line, trimmed and shortened.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    Batch {
        entries: Vec<FileEntry>,
        matches: Vec<ContentMatch>,
    },
    /// Items looked at so far (files read in content mode).
    Progress {
        scanned: u32,
    },
    Done {
        total: u32,
        cancelled: bool,
        truncated: bool,
    },
}

/// A result found by one of the engines, before it's stat'ed.
pub struct Hit {
    pub path: PathBuf,
    pub matched: Option<(u32, String)>,
}

/// Cancellation and progress shared between the engine threads and the collector.
pub struct Control {
    cancel: Arc<AtomicBool>,
    pub scanned: AtomicU32,
}

impl Control {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

#[derive(Default)]
pub struct SearchManager {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

/// Groups hits into batches and enforces the result limit.
struct Collector<'a> {
    channel: &'a Channel<SearchEvent>,
    entries: Vec<FileEntry>,
    matches: Vec<ContentMatch>,
    last_flush: Instant,
    last_progress: Instant,
    total: u32,
    truncated: bool,
}

impl Collector<'_> {
    fn push(&mut self, hit: Hit, control: &Control) {
        // Hits still queued when the search is stopped aren't worth a stat.
        if control.cancelled() {
            return;
        }
        if self.total >= MAX_RESULTS {
            self.truncated = true;
            control.stop();
            return;
        }
        let Some(entry) = crate::dir::build_entry_for(&hit.path) else { return };
        if let Some((line, text)) = hit.matched {
            self.matches.push(ContentMatch { path: entry.path.clone(), line, text });
        }
        self.entries.push(entry);
        self.total += 1;
        if self.entries.len() >= FLUSH_ITEMS || self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush(control);
        }
    }

    fn flush(&mut self, control: &Control) {
        if !self.entries.is_empty() {
            let event = SearchEvent::Batch {
                entries: std::mem::take(&mut self.entries),
                matches: std::mem::take(&mut self.matches),
            };
            // The frontend went away (tab closed): stop searching.
            if self.channel.send(event).is_err() {
                control.stop();
            }
        }
        self.last_flush = Instant::now();
    }

    fn tick(&mut self, control: &Control) {
        if self.last_flush.elapsed() >= FLUSH_INTERVAL {
            self.flush(control);
        }
        if self.last_progress.elapsed() >= PROGRESS_INTERVAL {
            let _ =
                self.channel.send(SearchEvent::Progress { scanned: control.scanned.load(Ordering::Relaxed) });
            self.last_progress = Instant::now();
        }
    }
}

/// Runs the search on worker threads and feeds their hits through the collector
/// until they finish, the limit is hit, or the search is cancelled.
pub fn run(
    scope: &Path,
    spec: &SearchSpec,
    control: Arc<Control>,
    channel: &Channel<SearchEvent>,
) -> AppResult<()> {
    let (tx, rx) = std::sync::mpsc::channel::<Hit>();
    let engine = {
        let scope = scope.to_path_buf();
        let spec = spec.clone();
        let control = Arc::clone(&control);
        match spec.mode {
            SearchMode::Name => {
                let matcher = name::NameMatcher::new(&spec.query, spec.case_sensitive)?;
                std::thread::spawn(move || name::search(&scope, &matcher, spec.include_hidden, &control, &tx))
            }
            SearchMode::Content => {
                let matcher = content::matcher(&spec.query, spec.case_sensitive, spec.regex)?;
                std::thread::spawn(move || {
                    content::search(&scope, &matcher, spec.include_hidden, &control, &tx);
                })
            }
            SearchMode::Spotlight | SearchMode::Tag => {
                let query = if spec.mode == SearchMode::Tag {
                    spotlight::tag_query(&spec.query)
                } else {
                    spec.query.clone()
                };
                std::thread::spawn(move || spotlight::search(&scope, &query, &control, &tx))
            }
        }
    };

    let mut out = Collector {
        channel,
        entries: Vec::new(),
        matches: Vec::new(),
        last_flush: Instant::now(),
        last_progress: Instant::now(),
        total: 0,
        truncated: false,
    };
    loop {
        match rx.recv_timeout(FLUSH_INTERVAL) {
            Ok(hit) => out.push(hit, &control),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        out.tick(&control);
    }
    let _ = engine.join();
    out.flush(&control);
    let cancelled = control.cancelled() && !out.truncated;
    let _ = channel.send(SearchEvent::Done { total: out.total, cancelled, truncated: out.truncated });
    Ok(())
}

/// Starts a search; results stream through `on_event` and end with `Done`.
#[tauri::command]
#[specta::specta]
pub async fn search_start(
    manager: State<'_, Arc<SearchManager>>,
    id: String,
    spec: SearchSpec,
    on_event: Channel<SearchEvent>,
) -> AppResult<()> {
    let scope = validate_path(&spec.scope)?;
    if !scope.is_dir() {
        return Err(AppError::NotADirectory { path: spec.scope });
    }
    if spec.query.trim().is_empty() {
        return Err(AppError::InvalidQuery { message: "the search is empty".into() });
    }
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut running) = manager.running.lock() {
        running.insert(id.clone(), Arc::clone(&cancel));
    }
    let control = Arc::new(Control { cancel, scanned: AtomicU32::new(0) });
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || {
        let result = run(&scope, &spec, control, &on_event);
        if let Ok(mut running) = manager.running.lock() {
            running.remove(&id);
        }
        result
    })
    .await
    .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

#[tauri::command]
#[specta::specta]
pub fn search_cancel(manager: State<'_, Arc<SearchManager>>, id: String) {
    if let Ok(running) = manager.running.lock()
        && let Some(flag) = running.get(&id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Shortens a matched line around its start for display.
pub fn snippet(line: &str) -> String {
    const MAX: usize = 200;
    let t = line.trim();
    if t.chars().count() <= MAX {
        t.to_owned()
    } else {
        format!("{}…", t.chars().take(MAX).collect::<String>())
    }
}

#[cfg(test)]
mod tests;
