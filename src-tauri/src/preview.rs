//! Data for the in-app preview pane. Media is served by the `asset:` protocol,
//! whose scope starts empty and only ever grows by files the user previewed.

use std::fs::File;
use std::io::Read as _;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager as _};

use crate::error::{AppError, AppResult};
use crate::security::validate_path;

/// Only the head of a file is read: a 50 MB log must not stall the UI.
const TEXT_LIMIT: usize = 256 * 1024;
/// Bytes shown by the hex view of a binary file.
const HEX_LIMIT: usize = 4 * 1024;
/// A NUL byte in the first chunk means the file isn't text.
const BINARY_PROBE: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    /// The file is longer than what was read.
    pub truncated: bool,
    pub binary: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn preview_text(path: String) -> AppResult<TextPreview> {
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_text(&p))
        .await
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

/// The head of a file as a hex dump (offset, bytes, ASCII), for binary files.
#[tauri::command]
#[specta::specta]
pub async fn preview_hex(path: String) -> AppResult<TextPreview> {
    let p = validate_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || read_hex(&p))
        .await
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

/// Lets the webview load `path` through `asset://` (images, audio, video).
#[tauri::command]
#[specta::specta]
pub async fn allow_preview(app: AppHandle, path: String) -> AppResult<()> {
    let p = validate_path(&path)?;
    let path2 = path.clone();
    tauri::async_runtime::spawn_blocking(move || allow_file(&app, &p, path2))
        .await
        .map_err(|e| AppError::Io { path: Some(path), message: e.to_string() })?
}

fn allow_file(app: &AppHandle, p: &Path, path: String) -> AppResult<()> {
    let meta = p.metadata().map_err(|e| AppError::from_io(&e, p))?;
    if !meta.is_file() {
        return Err(AppError::InvalidPath { path, reason: "not a file".into() });
    }
    let scope = app.asset_protocol_scope();
    let io = |e: tauri::Error| AppError::Io { path: Some(path.clone()), message: e.to_string() };
    scope.allow_file(p).map_err(io)?;
    // The protocol checks the resolved path of symlinks.
    if let Ok(real) = p.canonicalize()
        && real != p
    {
        scope.allow_file(&real).map_err(io)?;
    }
    Ok(())
}

/// Opens a regular file only: opening a pipe or a serial device would wait for
/// a writer (or carrier) forever, and could take data meant for another reader.
fn open_file(path: &Path) -> AppResult<File> {
    use std::os::unix::fs::OpenOptionsExt as _;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| AppError::from_io(&e, path))?;
    if !file.metadata().is_ok_and(|m| m.is_file()) {
        return Err(AppError::InvalidPath {
            path: path.to_string_lossy().into_owned(),
            reason: "not a file".into(),
        });
    }
    Ok(file)
}

pub fn read_text(path: &Path) -> AppResult<TextPreview> {
    let file = open_file(path)?;
    let mut buf = Vec::with_capacity(TEXT_LIMIT.min(64 * 1024));
    file.take(TEXT_LIMIT as u64 + 1).read_to_end(&mut buf).map_err(|e| AppError::from_io(&e, path))?;
    let truncated = buf.len() > TEXT_LIMIT;
    buf.truncate(TEXT_LIMIT);
    Ok(decode(buf, truncated))
}

pub fn read_hex(path: &Path) -> AppResult<TextPreview> {
    let file = open_file(path)?;
    let mut buf = Vec::with_capacity(HEX_LIMIT + 1);
    file.take(HEX_LIMIT as u64 + 1).read_to_end(&mut buf).map_err(|e| AppError::from_io(&e, path))?;
    let truncated = buf.len() > HEX_LIMIT;
    buf.truncate(HEX_LIMIT);
    Ok(TextPreview { text: hex_dump(&buf), truncated, binary: false })
}

/// `hexdump -C` style: 16 bytes a line, split in two groups, then printable ASCII.
fn hex_dump(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len().div_ceil(16) * 79);
    for (i, line) in bytes.chunks(16).enumerate() {
        let _ = write!(out, "{:08x} ", i * 16);
        for col in 0..16 {
            if col == 8 {
                out.push(' ');
            }
            match line.get(col) {
                Some(b) => {
                    let _ = write!(out, " {b:02x}");
                }
                None => out.push_str("   "),
            }
        }
        out.push_str("  |");
        out.extend(line.iter().map(|&b| if b.is_ascii_graphic() || b == b' ' { b as char } else { '.' }));
        out.push_str("|\n");
    }
    out
}

fn decode(buf: Vec<u8>, truncated: bool) -> TextPreview {
    let text = |text: String| TextPreview { text, truncated, binary: false };
    if let Some(utf16) = decode_utf16(&buf) {
        return text(utf16);
    }
    if buf[..buf.len().min(BINARY_PROBE)].contains(&0) {
        return TextPreview { text: String::new(), truncated, binary: true };
    }
    let body = buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&buf);
    match std::str::from_utf8(body) {
        Ok(s) => text(s.to_owned()),
        // The cut at TEXT_LIMIT can split a multi-byte character.
        Err(e) if e.error_len().is_none() => text(String::from_utf8_lossy(&body[..e.valid_up_to()]).into()),
        Err(_) => text(String::from_utf8_lossy(body).into_owned()),
    }
}

/// UTF-16 is only recognized with a byte-order mark.
fn decode_utf16(buf: &[u8]) -> Option<String> {
    let (le, body) = match buf {
        [0xFF, 0xFE, rest @ ..] => (true, rest),
        [0xFE, 0xFF, rest @ ..] => (false, rest),
        _ => return None,
    };
    let units = body
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&c| if le { u16::from_le_bytes(c) } else { u16::from_be_bytes(c) });
    Some(char::decode_utf16(units).map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_text_encodings() {
        assert_eq!(decode(b"\xEF\xBB\xBFhi".to_vec(), false).text, "hi");
        assert_eq!(decode(vec![0xFF, 0xFE, b'h', 0, b'i', 0], false).text, "hi");
        assert_eq!(decode(vec![0xFE, 0xFF, 0, b'h', 0, b'i'], false).text, "hi");
        assert!(decode(vec![b'a', 0, b'b'], false).binary);
        // "ç" cut in half at the read limit is dropped, not turned into U+FFFD.
        assert_eq!(decode(vec![b'a', 0xC3], true).text, "a");
        assert_eq!(decode(vec![b'a', 0xFF, b'b'], false).text, "a\u{FFFD}b");
    }

    #[test]
    fn dumps_hex_like_hexdump() {
        let dump = hex_dump(b"MZ\x90\x00hello, world!\n\xffAB");
        let lines: Vec<&str> = dump.lines().collect();
        assert_eq!(
            lines[0],
            "00000000  4d 5a 90 00 68 65 6c 6c  6f 2c 20 77 6f 72 6c 64  |MZ..hello, world|"
        );
        assert_eq!(lines[1], "00000010  21 0a ff 41 42                                    |!..AB|");
        assert_eq!(hex_dump(b""), "");
    }

    #[test]
    fn reads_only_the_head_of_large_files() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("big.log");
        std::fs::write(&f, "x".repeat(TEXT_LIMIT * 3)).unwrap();
        let p = read_text(&f).unwrap();
        assert!(p.truncated);
        assert_eq!(p.text.len(), TEXT_LIMIT);

        std::fs::write(&f, "short").unwrap();
        let p = read_text(&f).unwrap();
        assert!(!p.truncated);
        assert_eq!(p.text, "short");
    }

    #[test]
    fn a_pipe_or_device_is_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        // Control: a file.
        let f = tmp.path().join("f.txt");
        std::fs::write(&f, "text").unwrap();
        assert_eq!(read_text(&f).unwrap().text, "text");

        let fifo = tmp.path().join("pipe");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        for read in [read_text, read_hex] {
            let (tx, rx) = std::sync::mpsc::channel();
            let p = fifo.clone();
            std::thread::spawn(move || tx.send(read(&p).is_err()).unwrap());
            let r = rx.recv_timeout(std::time::Duration::from_secs(5));
            if r.is_err() {
                // Release the stuck reader before failing.
                let _ = std::fs::OpenOptions::new().write(true).open(&fifo);
            }
            assert_eq!(r, Ok(true), "previewing a pipe hung or read it");
        }
        // A folder, and a character device, are not files either.
        assert!(read_text(tmp.path()).is_err());
        assert!(read_hex(Path::new("/dev/null")).is_err());
        // An empty file is fine.
        let empty = tmp.path().join("empty");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(read_text(&empty).unwrap().text, "");
    }
}
