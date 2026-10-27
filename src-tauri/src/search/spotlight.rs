//! Spotlight search through `mdfind`, which prints NUL-separated paths as it
//! finds them. The query is passed as one argument, never through a shell.

use std::io::{BufRead as _, BufReader};
use std::os::unix::ffi::OsStringExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{RecvTimeoutError, Sender};
use std::time::Duration;

use super::{Control, Hit};

/// A Spotlight query for items carrying the Finder tag `name`.
pub fn tag_query(name: &str) -> String {
    let escaped = name.replace('\\', "\\\\").replace('\'', "\\'");
    format!("kMDItemUserTags == '{escaped}'")
}

pub fn search(root: &Path, query: &str, control: &Control, tx: &Sender<Hit>) {
    let child = Command::new("/usr/bin/mdfind")
        .arg("-0")
        .arg("-onlyin")
        .arg(root)
        .arg(query)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        log::warn!("mdfind could not be started");
        return;
    };
    let Some(stdout) = child.stdout.take() else { return };

    // Reading blocks while mdfind is quiet, so it happens on its own thread and
    // cancellation is checked here between results.
    let (paths_tx, paths_rx) = std::sync::mpsc::channel::<PathBuf>();
    let reader = std::thread::spawn(move || {
        for item in BufReader::new(stdout).split(0) {
            let Ok(bytes) = item else { break };
            if bytes.is_empty() {
                continue;
            }
            let path = PathBuf::from(std::ffi::OsString::from_vec(bytes));
            if paths_tx.send(path).is_err() {
                break;
            }
        }
    });
    loop {
        if control.cancelled() {
            let _ = child.kill();
            break;
        }
        match paths_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(path) => {
                control.scanned.fetch_add(1, Ordering::Relaxed);
                if tx.send(Hit { path, matched: None }).is_err() {
                    let _ = child.kill();
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.wait();
    let _ = reader.join();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_names_are_quoted_for_spotlight() {
        assert_eq!(tag_query("Red"), "kMDItemUserTags == 'Red'");
        assert_eq!(tag_query(r"it's \ odd"), r"kMDItemUserTags == 'it\'s \\ odd'");
    }
}
