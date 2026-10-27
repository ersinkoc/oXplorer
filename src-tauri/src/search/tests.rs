use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};

use super::*;

fn spec(scope: &Path, mode: SearchMode, query: &str) -> SearchSpec {
    SearchSpec {
        scope: scope.to_string_lossy().into_owned(),
        query: query.into(),
        mode,
        case_sensitive: false,
        regex: false,
        include_hidden: false,
    }
}

/// Runs a search to completion; returns the events as JSON values.
fn collect(spec: &SearchSpec, control: Arc<Control>) -> Vec<serde_json::Value> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let channel: Channel<SearchEvent> = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            sink.lock().unwrap().push(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    run(Path::new(&spec.scope), spec, control, &channel).unwrap();
    events.lock().unwrap().clone()
}

fn control() -> Arc<Control> {
    Arc::new(Control { cancel: Arc::new(AtomicBool::new(false)), scanned: AtomicU32::new(0) })
}

fn result_names(events: &[serde_json::Value]) -> Vec<String> {
    let mut names: Vec<String> = events
        .iter()
        .filter(|e| e["type"] == "batch")
        .flat_map(|e| e["entries"].as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_owned()))
        .collect();
    names.sort();
    names
}

fn fixture() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let r = tmp.path();
    fs::create_dir_all(r.join("src/deep")).unwrap();
    fs::create_dir_all(r.join("Tool.app/Contents")).unwrap();
    fs::create_dir_all(r.join("target")).unwrap();
    fs::write(r.join("src/main.rs"), "fn main() {\n    println!(\"Hello Report\");\n}\n").unwrap();
    fs::write(r.join("src/deep/report final.txt"), "nothing here\n").unwrap();
    // Decomposed "ç", as HFS+ and many tools write it.
    fs::write(r.join("src/c\u{0327}ay.md"), "tea\n").unwrap();
    fs::write(r.join("Tool.app/Contents/report.txt"), "report inside a bundle\n").unwrap();
    fs::write(r.join("target/report.log"), "report in ignored dir\n").unwrap();
    fs::write(r.join(".hidden-report"), "report\n").unwrap();
    fs::write(r.join("binary.bin"), b"report\0\x01\x02").unwrap();
    fs::write(r.join(".gitignore"), "target/\n").unwrap();
    tmp
}

#[test]
fn name_search_matches_substrings_globs_and_unicode() {
    let tmp = fixture();
    let names = result_names(&collect(&spec(tmp.path(), SearchMode::Name, "REPORT"), control()));
    // Hidden files and bundle contents are left out; .gitignore doesn't apply to names.
    assert_eq!(names, vec!["report final.txt", "report.log"]);

    let names = result_names(&collect(&spec(tmp.path(), SearchMode::Name, "*.rs"), control()));
    assert_eq!(names, vec!["main.rs"]);

    let names = result_names(&collect(&spec(tmp.path(), SearchMode::Name, "çay"), control()));
    assert_eq!(names.len(), 1, "{names:?}");

    let names = result_names(&collect(&spec(tmp.path(), SearchMode::Name, "tool"), control()));
    assert_eq!(names, vec!["Tool.app"]);

    let mut hidden = spec(tmp.path(), SearchMode::Name, "report");
    hidden.include_hidden = true;
    assert!(result_names(&collect(&hidden, control())).contains(&".hidden-report".to_owned()));
}

#[test]
fn content_search_reports_lines_and_skips_ignored_and_binary() {
    let tmp = fixture();
    let events = collect(&spec(tmp.path(), SearchMode::Content, "report"), control());
    assert_eq!(result_names(&events), vec!["main.rs"]);
    let m = &events.iter().find(|e| e["type"] == "batch").unwrap()["matches"][0];
    assert_eq!(m["line"], 2);
    assert_eq!(m["text"], "println!(\"Hello Report\");");

    let mut exact = spec(tmp.path(), SearchMode::Content, "report");
    exact.case_sensitive = true;
    assert!(result_names(&collect(&exact, control())).is_empty());

    let mut re = spec(tmp.path(), SearchMode::Content, r"fn\s+main");
    re.regex = true;
    assert_eq!(result_names(&collect(&re, control())), vec!["main.rs"]);

    let mut bad = spec(tmp.path(), SearchMode::Content, "(");
    bad.regex = true;
    let channel: Channel<SearchEvent> = Channel::new(|_| Ok(()));
    assert!(matches!(run(tmp.path(), &bad, control(), &channel), Err(AppError::InvalidQuery { .. })));
}

#[test]
fn cancelled_search_ends_with_done() {
    let tmp = fixture();
    let c = control();
    c.stop();
    let events = collect(&spec(tmp.path(), SearchMode::Name, "a"), c);
    let done = events.last().unwrap();
    assert_eq!(done["type"], "done");
    assert_eq!(done["cancelled"], true);
}

#[test]
fn results_stop_at_the_limit() {
    let tmp = tempfile::tempdir().unwrap();
    for i in 0..(MAX_RESULTS + 50) {
        fs::write(tmp.path().join(format!("f{i}")), "").unwrap();
    }
    let events = collect(&spec(tmp.path(), SearchMode::Name, "f"), control());
    let done = events.last().unwrap();
    assert_eq!(done["total"], MAX_RESULTS);
    assert_eq!(done["truncated"], true);
    assert_eq!(done["cancelled"], false);
    assert!(events.iter().filter(|e| e["type"] == "batch").count() > 1, "results should stream in batches");
}

/// DoD check: a content search over the home folder streams results and stops
/// promptly when cancelled (`OX_BENCH_DIR` overrides the folder, `OX_BENCH_QUERY` the text,
/// `OX_BENCH_CANCEL_MS` when to cancel).
/// `cargo test --release --lib bench_content_home -- --ignored --nocapture`
/// Files in TCC-protected folders (Documents, Desktop) can take seconds to open
/// under parallel load; an open() in flight can't be interrupted.
#[test]
#[ignore = "searches the real home folder"]
fn bench_content_home() {
    let home = std::env::var_os("OX_BENCH_DIR").map_or_else(|| dirs::home_dir().unwrap(), PathBuf::from);
    let query = std::env::var("OX_BENCH_QUERY").unwrap_or_else(|_| "TODO".into());
    let started = Instant::now();
    let first = Arc::new(Mutex::new(None::<Duration>));
    let first_sink = Arc::clone(&first);
    let done_at = Arc::new(Mutex::new(None::<(Instant, serde_json::Value)>));
    let done_sink = Arc::clone(&done_at);
    let channel: Channel<SearchEvent> = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let v: serde_json::Value = serde_json::from_str(&json).unwrap();
            if v["type"] == "batch" {
                first_sink.lock().unwrap().get_or_insert(started.elapsed());
            } else if v["type"] == "done" {
                *done_sink.lock().unwrap() = Some((Instant::now(), v));
            }
        }
        Ok(())
    });
    let c = control();
    let canceller = Arc::clone(&c);
    let cancel_after = Duration::from_millis(
        std::env::var("OX_BENCH_CANCEL_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(3000),
    );
    let cancelled_at = Arc::new(Mutex::new(None::<Instant>));
    let cancelled_sink = Arc::clone(&cancelled_at);
    std::thread::spawn(move || {
        std::thread::sleep(cancel_after);
        *cancelled_sink.lock().unwrap() = Some(Instant::now());
        canceller.stop();
    });
    let mut s = spec(&home, SearchMode::Content, &query);
    s.case_sensitive = true;
    run(&home, &s, Arc::clone(&c), &channel).unwrap();
    let (done, summary) = done_at.lock().unwrap().clone().unwrap();
    let stop_latency = cancelled_at.lock().unwrap().map(|t| done.saturating_duration_since(t));
    println!(
        "first batch {:?}, scanned {}, summary {summary}, stop latency after cancel {:?}",
        first.lock().unwrap(),
        c.scanned.load(std::sync::atomic::Ordering::Relaxed),
        stop_latency
    );
}

/// Spotlight through mdfind: needs an indexed volume, so it only runs on request.
/// `cargo test --lib spotlight_finds_indexed_files -- --ignored`
#[test]
#[ignore = "depends on the Spotlight index"]
fn spotlight_finds_indexed_files() {
    let apps = Path::new("/System/Applications");
    let events = collect(&spec(apps, SearchMode::Spotlight, "kMDItemFSName == 'Calculator.app'"), control());
    assert_eq!(result_names(&events), vec!["Calculator.app"]);
    // Tags: whatever the result, the query runs and finishes cleanly.
    let events = collect(&spec(apps, SearchMode::Tag, "Red"), control());
    assert_eq!(events.last().unwrap()["type"], "done");
}
