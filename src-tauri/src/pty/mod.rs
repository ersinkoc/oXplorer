//! Terminal sessions: the user's login shell on a pseudo-terminal, streamed to
//! xterm.js through a channel.

mod integration;

use std::collections::HashMap;
use std::io::{Read as _, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager as _, State};

use crate::error::{AppError, AppResult};
use crate::security::validate_path;

const READ_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    /// Terminal output, decoded as UTF-8 (sequences split across reads are joined).
    Output { data: String },
    /// The shell exited; nothing follows.
    Exit { code: Option<u32> },
}

struct Session {
    /// Label of the window the terminal is in; its shells end with it.
    window: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

impl PtyManager {
    fn get(&self, id: &str) -> AppResult<Arc<Mutex<Session>>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|m| m.get(id).cloned())
            .ok_or_else(|| AppError::Io { path: None, message: format!("no terminal session {id}") })
    }

    /// Drops `id` only if it is still `session` (the id may have been reused).
    fn remove_if_same(&self, id: &str, session: &Arc<Mutex<Session>>) {
        if let Ok(mut map) = self.sessions.lock()
            && map.get(id).is_some_and(|s| Arc::ptr_eq(s, session))
        {
            map.remove(id);
        }
    }

    fn remove(&self, id: &str) -> Option<Arc<Mutex<Session>>> {
        self.sessions.lock().ok()?.remove(id)
    }

    /// Ends the shells of a window that was closed.
    pub fn close_window(&self, label: &str) {
        let Ok(mut map) = self.sessions.lock() else { return };
        map.retain(|_, session| {
            let Ok(mut s) = session.lock() else { return true };
            if s.window != label {
                return true;
            }
            let _ = s.child.kill();
            false
        });
    }
}

fn pty_err(e: impl std::fmt::Display) -> AppError {
    AppError::Io { path: None, message: e.to_string() }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 }
}

/// The login shell with a terminal environment; zsh gets the cwd-reporting hook.
fn shell_command(cwd: &Path, integration_base: Option<&Path>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "OXplorer");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Apps launched from Finder get no locale; without one zsh mangles UTF-8.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    for leaked in ["OX_SELFTEST_DIR", "OX_USER_ZDOTDIR"] {
        cmd.env_remove(leaked);
    }
    let is_zsh = Path::new(&cmd.get_shell()).file_name().is_some_and(|n| n == "zsh");
    if is_zsh && let Some(dir) = integration_base.and_then(|b| integration::install_zsh(b).ok()) {
        if let Some(user) = std::env::var_os("ZDOTDIR") {
            cmd.env("OX_USER_ZDOTDIR", user);
        }
        cmd.env("ZDOTDIR", dir);
    }
    cmd
}

/// Splits off a trailing incomplete UTF-8 sequence so it can be completed by the next read.
fn decode_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_owned();
            pending.clear();
            out
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).into_owned();
            pending.drain(..valid);
            out
        }
        Err(_) => {
            let out = String::from_utf8_lossy(pending).into_owned();
            pending.clear();
            out
        }
    }
}

/// Starts a shell in `cwd` (home if it isn't a folder) and streams its output.
#[tauri::command]
#[specta::specta]
pub fn pty_open(
    window: tauri::Window,
    manager: State<'_, Arc<PtyManager>>,
    id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> AppResult<()> {
    let cwd = validate_path(&cwd)
        .ok()
        .filter(|p| p.is_dir())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(pty_err)?;
    let base = window.path().app_cache_dir().ok();
    let child = pair.slave.spawn_command(shell_command(&cwd, base.as_deref())).map_err(pty_err)?;
    // The child holds its own copy of the slave side.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
    let writer = pair.master.take_writer().map_err(pty_err)?;
    let session = Arc::new(Mutex::new(Session {
        window: window.label().to_owned(),
        master: pair.master,
        writer,
        child,
    }));
    if let Ok(mut map) = manager.sessions.lock() {
        map.insert(id.clone(), Arc::clone(&session));
    }

    let manager = Arc::clone(&manager);
    std::thread::Builder::new()
        .name(format!("pty-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            let mut pending = Vec::new();
            // The page is gone (window closed): the shell is still running.
            let mut orphaned = false;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);
                        let data = decode_utf8(&mut pending);
                        if !data.is_empty() && on_event.send(PtyEvent::Output { data }).is_err() {
                            orphaned = true;
                            break;
                        }
                    }
                }
            }
            // Waiting holds the session lock, so a live shell must end first or
            // `pty_close` / `close_window` would block on it forever.
            let code = session
                .lock()
                .ok()
                .and_then(|mut s| {
                    if orphaned {
                        let _ = s.child.kill();
                    }
                    s.child.wait().ok()
                })
                .map(|s| s.exit_code());
            manager.remove_if_same(&id, &session);
            let _ = on_event.send(PtyEvent::Exit { code });
        })
        .map_err(pty_err)?;
    Ok(())
}

/// Keyboard input (and pasted text) for the shell.
#[tauri::command]
#[specta::specta]
pub fn pty_write(manager: State<'_, Arc<PtyManager>>, id: String, data: String) -> AppResult<()> {
    let session = manager.get(&id)?;
    let mut s = session.lock().map_err(pty_err)?;
    s.writer.write_all(data.as_bytes()).and_then(|()| s.writer.flush()).map_err(pty_err)
}

#[tauri::command]
#[specta::specta]
pub fn pty_resize(manager: State<'_, Arc<PtyManager>>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    let session = manager.get(&id)?;
    let s = session.lock().map_err(pty_err)?;
    s.master.resize(size(cols, rows)).map_err(pty_err)
}

/// Ends the shell (SIGHUP via the closed terminal, then kill).
#[tauri::command]
#[specta::specta]
pub fn pty_close(manager: State<'_, Arc<PtyManager>>, id: String) -> AppResult<()> {
    if let Some(session) = manager.remove(&id)
        && let Ok(mut s) = session.lock()
    {
        let _ = s.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_utf8_split_across_reads() {
        let mut pending = "aç".as_bytes()[..2].to_vec();
        assert_eq!(decode_utf8(&mut pending), "a");
        assert_eq!(pending, vec![0xC3]);
        pending.push(0xA7);
        assert_eq!(decode_utf8(&mut pending), "ç");
        assert!(pending.is_empty());
        let mut bad = vec![b'x', 0xFF, b'y'];
        assert_eq!(decode_utf8(&mut bad), "x\u{FFFD}y");
    }

    /// Everything a pty prints, read on a background thread (one reader per pty).
    struct Output {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        text: String,
    }

    impl Output {
        fn new(mut reader: Box<dyn std::io::Read + Send>) -> Self {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            Self { rx, text: String::new() }
        }

        /// Waits (up to 20 s) until `needle` has been printed.
        fn wait_for(&mut self, needle: &str) -> bool {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !self.text.contains(needle) && std::time::Instant::now() < deadline {
                if let Ok(c) = self.rx.recv_timeout(std::time::Duration::from_millis(100)) {
                    self.text.push_str(&String::from_utf8_lossy(&c));
                }
            }
            self.text.contains(needle)
        }
    }

    /// The real login shell: runs a command, follows a resize, and (for zsh)
    /// reports its directory with OSC 7 through the integration files.
    #[test]
    fn login_shell_resizes_and_reports_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().join("dir with space");
        std::fs::create_dir(&cwd).unwrap();
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let cmd = shell_command(&cwd, Some(tmp.path()));
        let zsh = cmd.get_shell().ends_with("zsh");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut out = Output::new(pair.master.try_clone_reader().unwrap());
        let mut writer = pair.master.take_writer().unwrap();

        pair.master.resize(size(101, 33)).unwrap();
        writer.write_all(b"stty size; echo ox-$((40+2)); exit\r").unwrap();
        assert!(out.wait_for("\nox-42"), "{}", out.text);
        assert!(out.text.contains("33 101"), "{}", out.text);
        if zsh {
            assert!(
                out.text.contains("\x1b]7;file://") && out.text.contains("dir%20with%20space"),
                "{}",
                out.text
            );
        }
        let _ = child.wait();
    }

    /// A full-screen TUI: enters the alternate screen, redraws on resize
    /// (SIGWINCH) at the new size, and exits cleanly.
    #[test]
    fn vim_uses_alternate_screen_and_follows_resize() {
        if !Path::new("/usr/bin/vim").exists() {
            return;
        }
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = CommandBuilder::new("/usr/bin/vim");
        cmd.args(["-u", "NONE", "-N", "-n"]);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut out = Output::new(pair.master.try_clone_reader().unwrap());
        let mut writer = pair.master.take_writer().unwrap();
        assert!(out.wait_for("\x1b[?1049h"), "no alternate screen");
        pair.master.resize(size(120, 40)).unwrap();
        // vim reports its idea of the size; it must match the resized pty.
        writer.write_all(b":echo &columns . 'x' . &lines\r").unwrap();
        assert!(out.wait_for("120x40"), "vim didn't see the resize");
        writer.write_all(b":q!\r").unwrap();
        assert!(out.wait_for("\x1b[?1049l"), "alternate screen not left");
        assert!(child.wait().unwrap().success());
    }

    /// `htop` started from the login shell (PATH from the user's profile):
    /// alternate screen, resize, quit back to the prompt. Needs htop installed:
    /// `cargo test --lib pty::tests::htop -- --ignored`
    #[test]
    #[ignore = "needs htop on the login shell's PATH"]
    fn htop_from_login_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let pair = native_pty_system().openpty(size(100, 30)).unwrap();
        let mut child = pair.slave.spawn_command(shell_command(tmp.path(), Some(tmp.path()))).unwrap();
        drop(pair.slave);
        let mut out = Output::new(pair.master.try_clone_reader().unwrap());
        let mut writer = pair.master.take_writer().unwrap();
        writer.write_all(b"htop\r").unwrap();
        assert!(out.wait_for("\x1b[?1049h"), "htop didn't start: {}", out.text);
        pair.master.resize(size(140, 45)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        writer.write_all(b"q").unwrap();
        writer.write_all(b"echo back-$((1+1)); exit\r").unwrap();
        assert!(out.wait_for("back-2"), "{}", out.text);
        assert!(child.wait().unwrap().success());
    }
}
