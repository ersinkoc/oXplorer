//! Remote folders (SFTP, WebDAV, S3) through OpenDAL, browsed under
//! `remote:<connection id>/<path>`. Connection settings come from the
//! frontend; passwords and secret keys live only in the macOS Keychain.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use opendal::{EntryMode, Operator, services};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager as _};

use crate::error::{AppError, AppResult};
use crate::model::{EntryKind, FileEntry};

pub const PREFIX: &str = "remote:";
const KEYCHAIN_SERVICE: &str = "OXplorer connection";
const CHUNK: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RemoteKind {
    Sftp,
    Webdav,
    S3,
}

/// A saved connection (no secrets: see `remote_save_secret`).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub kind: RemoteKind,
    /// SFTP: `host` or `host:port`. WebDAV: the server URL. S3: a custom endpoint (empty for AWS).
    pub host: String,
    /// SFTP / WebDAV user, or the S3 access key id.
    pub user: String,
    /// Folder on the server shown as the connection's top.
    pub root: String,
    /// S3 only.
    pub bucket: String,
    /// S3 only (e.g. `eu-central-1`).
    pub region: String,
}

static CONNECTIONS: LazyLock<Mutex<HashMap<String, Connection>>> = LazyLock::new(Default::default);
static OPERATORS: LazyLock<Mutex<HashMap<String, Operator>>> = LazyLock::new(Default::default);

fn remote_err(path: &str, e: &opendal::Error) -> AppError {
    use opendal::ErrorKind as K;
    match e.kind() {
        K::NotFound => AppError::NotFound { path: path.to_owned() },
        K::PermissionDenied => {
            AppError::PermissionDenied { path: path.to_owned(), needs_full_disk_access: false }
        }
        K::AlreadyExists => AppError::AlreadyExists { path: path.to_owned() },
        K::NotADirectory => AppError::NotADirectory { path: path.to_owned() },
        _ => AppError::Io { path: Some(path.to_owned()), message: e.to_string() },
    }
}

fn secret(id: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, id)
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        None
    }
}

fn build(conn: &Connection, secret: Option<&str>) -> AppResult<Operator> {
    let fail = |e: opendal::Error| AppError::Io { path: None, message: format!("{}: {e}", conn.name) };
    let root = if conn.root.trim().is_empty() { "/" } else { conn.root.trim() };
    let op = match conn.kind {
        RemoteKind::Sftp => {
            // Authentication is the user's SSH setup (agent, keys, ~/.ssh/config).
            let mut b = services::Sftp::default().endpoint(&conn.host).root(root);
            if !conn.user.is_empty() {
                b = b.user(&conn.user);
            }
            Operator::new(b).map_err(fail)?
        }
        RemoteKind::Webdav => {
            let mut b = services::Webdav::default().endpoint(&conn.host).root(root);
            if !conn.user.is_empty() {
                b = b.username(&conn.user);
            }
            if let Some(s) = secret {
                b = b.password(s);
            }
            Operator::new(b).map_err(fail)?
        }
        RemoteKind::S3 => {
            let mut b = services::S3::default()
                .bucket(&conn.bucket)
                .root(root)
                .region(if conn.region.is_empty() { "us-east-1" } else { &conn.region })
                // Only what's configured here, never ~/.aws or the environment.
                .disable_config_load();
            if !conn.host.is_empty() {
                b = b.endpoint(&conn.host);
            }
            if !conn.user.is_empty() {
                b = b.access_key_id(&conn.user);
            }
            if let Some(s) = secret {
                b = b.secret_access_key(s);
            }
            Operator::new(b).map_err(fail)?
        }
    };
    Ok(op)
}

/// `remote:<id>/<inner>` → (operator, inner path without leading slash).
pub fn resolve(path: &str) -> AppResult<(Operator, String)> {
    let invalid = || AppError::InvalidPath { path: path.to_owned(), reason: "not a remote location".into() };
    let rest = path.strip_prefix(PREFIX).ok_or_else(invalid)?;
    let (id, inner) = rest.split_once('/').unwrap_or((rest, ""));
    let inner = inner.trim_matches('/');
    if inner.split('/').any(|c| c == ".." || c == ".") {
        return Err(invalid());
    }
    if let Some(op) = OPERATORS.lock().ok().and_then(|m| m.get(id).cloned()) {
        return Ok((op, inner.to_owned()));
    }
    let conn = CONNECTIONS
        .lock()
        .ok()
        .and_then(|m| m.get(id).cloned())
        .ok_or_else(|| AppError::NotFound { path: path.to_owned() })?;
    let op = build(&conn, secret(id).as_deref())?;
    if let Ok(mut m) = OPERATORS.lock() {
        m.insert(id.to_owned(), op.clone());
    }
    Ok((op, inner.to_owned()))
}

fn virtual_path(id: &str, inner: &str) -> String {
    format!("{PREFIX}{id}/{inner}")
}

fn id_of(path: &str) -> &str {
    path.strip_prefix(PREFIX).and_then(|r| r.split('/').next()).unwrap_or("")
}

fn dir_key(inner: &str) -> String {
    if inner.is_empty() { String::new() } else { format!("{inner}/") }
}

fn millis(t: Option<SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}

/// The connection list from the frontend (replaces the previous one).
#[tauri::command]
#[specta::specta]
pub fn remote_set_connections(connections: Vec<Connection>) {
    if let Ok(mut m) = CONNECTIONS.lock() {
        *m = connections.into_iter().map(|c| (c.id.clone(), c)).collect();
    }
    // Settings may have changed: operators are rebuilt on next use.
    if let Ok(mut m) = OPERATORS.lock() {
        m.clear();
    }
}

/// Stores a connection's password / secret key in the Keychain (empty removes it).
#[tauri::command]
#[specta::specta]
pub fn remote_save_secret(id: String, secret: String) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::{delete_generic_password, set_generic_password};
        let r = if secret.is_empty() {
            delete_generic_password(KEYCHAIN_SERVICE, &id).or(Ok(()))
        } else {
            set_generic_password(KEYCHAIN_SERVICE, &id, secret.as_bytes())
        };
        r.map_err(|e: security_framework::base::Error| AppError::Io { path: None, message: e.to_string() })?;
    }
    if let Ok(mut m) = OPERATORS.lock() {
        m.remove(&id);
    }
    Ok(())
}

/// Whether a password / secret key is stored for the connection.
#[tauri::command]
#[specta::specta]
pub fn remote_has_secret(id: String) -> bool {
    secret(&id).is_some()
}

/// Tries to list the top of a connection (with an unsaved secret, if given).
#[tauri::command]
#[specta::specta]
pub async fn remote_test(connection: Connection, secret_override: Option<String>) -> AppResult<()> {
    let s = secret_override.filter(|s| !s.is_empty()).or_else(|| secret(&connection.id));
    let op = build(&connection, s.as_deref())?;
    op.list("").await.map(|_| ()).map_err(|e| remote_err(&connection.name, &e))
}

/// Lists a remote folder.
#[tauri::command]
#[specta::specta]
pub async fn remote_list(path: String) -> AppResult<Vec<FileEntry>> {
    let (op, inner) = resolve(&path)?;
    let id = id_of(&path).to_owned();
    let key = dir_key(&inner);
    let entries = op.list(&key).await.map_err(|e| remote_err(&path, &e))?;
    Ok(entries
        .into_iter()
        // The listed folder itself comes back too (as "" or "/" at the top).
        .filter(|e| {
            e.path().trim_matches('/') != key.trim_matches('/') && !e.name().trim_matches('/').is_empty()
        })
        .map(|e| {
            let meta = e.metadata();
            let is_dir = meta.mode() == EntryMode::DIR;
            let name = e.name().trim_end_matches('/').to_owned();
            let child = format!("{key}{name}");
            let extension = (!is_dir)
                .then(|| Path::new(&name).extension().map(|x| x.to_string_lossy().into_owned()))
                .flatten();
            FileEntry {
                path: virtual_path(&id, &child),
                kind: if is_dir { EntryKind::Dir } else { EntryKind::File },
                symlink: None,
                size: if is_dir { 0 } else { meta.content_length() },
                allocated: 0,
                modified_ms: millis(meta.last_modified().map(SystemTime::from)),
                created_ms: None,
                accessed_ms: None,
                mode: if is_dir { 0o755 } else { 0o644 },
                uid: 0,
                gid: 0,
                inode: 0,
                is_hidden: name.starts_with('.'),
                is_system_junk: name == ".DS_Store",
                extension,
                tags: Vec::new(),
                name,
            }
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn remote_create_dir(parent: String, name: String) -> AppResult<String> {
    crate::jobs::check_name(&name)?;
    let (op, inner) = resolve(&parent)?;
    let child = format!("{}{name}", dir_key(&inner));
    op.create_dir(&format!("{child}/")).await.map_err(|e| remote_err(&parent, &e))?;
    Ok(virtual_path(id_of(&parent), &child))
}

#[tauri::command]
#[specta::specta]
pub async fn remote_rename(path: String, new_name: String) -> AppResult<String> {
    crate::jobs::check_name(&new_name)?;
    let (op, inner) = resolve(&path)?;
    let parent = inner.rsplit_once('/').map_or("", |(p, _)| p);
    let to = format!("{}{new_name}", dir_key(parent));
    let is_dir =
        op.stat(&inner).await.is_ok_and(|m| m.is_dir()) || op.stat(&format!("{inner}/")).await.is_ok();
    let (from_key, to_key) =
        if is_dir { (format!("{inner}/"), format!("{to}/")) } else { (inner.clone(), to.clone()) };
    op.rename(&from_key, &to_key).await.map_err(|e| remote_err(&path, &e))?;
    Ok(virtual_path(id_of(&path), &to))
}

/// Deletes remote items permanently (servers have no Trash).
#[tauri::command]
#[specta::specta]
pub async fn remote_delete(paths: Vec<String>) -> AppResult<()> {
    for path in paths {
        let (op, inner) = resolve(&path)?;
        if inner.is_empty() {
            return Err(AppError::InvalidPath {
                path,
                reason: "the connection's top folder can't be deleted".into(),
            });
        }
        // A folder (and everything in it), or a file.
        let dir = format!("{inner}/");
        if op.stat(&dir).await.is_ok_and(|m| m.is_dir()) {
            op.delete_with(&dir).recursive(true).await.map_err(|e| remote_err(&path, &e))?;
        } else {
            op.delete(&inner).await.map_err(|e| remote_err(&path, &e))?;
        }
    }
    Ok(())
}

/// Downloads one remote file to a private temporary folder (to open or preview it).
#[tauri::command]
#[specta::specta]
pub async fn remote_open_member(app: AppHandle, path: String) -> AppResult<String> {
    let (op, inner) = resolve(&path)?;
    let base = app.path().app_cache_dir().map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    let name = inner.rsplit('/').next().unwrap_or("file").to_owned();
    let dir = base.join("remote-open").join(id_of(&path)).join(inner.replace('/', "_"));
    std::fs::create_dir_all(&dir).map_err(|e| AppError::from_io(&e, &dir))?;
    let out = dir.join(&name);
    download_file(&op, &inner, &out, &mut |_| true).await.map_err(|e| e.into_app(&path))?;
    Ok(out.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Transfers (run as jobs; `tick` reports bytes and returns false to stop)

pub enum TransferError {
    Cancelled,
    Remote(opendal::Error),
    Local(std::io::Error, PathBuf),
}

impl TransferError {
    pub fn into_app(self, path: &str) -> AppError {
        match self {
            Self::Cancelled => AppError::Cancelled,
            Self::Remote(e) => remote_err(path, &e),
            Self::Local(e, p) => AppError::from_io(&e, &p),
        }
    }
}

async fn download_file<F: FnMut(u64) -> bool>(
    op: &Operator,
    key: &str,
    out: &Path,
    tick: &mut F,
) -> Result<(), TransferError> {
    use std::io::Write as _;
    let size = op.stat(key).await.map_err(TransferError::Remote)?.content_length();
    let reader = op.reader(key).await.map_err(TransferError::Remote)?;
    let mut file = std::fs::File::create(out).map_err(|e| TransferError::Local(e, out.to_path_buf()))?;
    let mut offset = 0;
    while offset < size {
        let end = (offset + CHUNK).min(size);
        let buf = reader.read(offset..end).await.map_err(TransferError::Remote)?;
        file.write_all(&buf.to_vec()).map_err(|e| TransferError::Local(e, out.to_path_buf()))?;
        offset = end;
        if !tick(buf.len() as u64) {
            drop(file);
            let _ = std::fs::remove_file(out);
            return Err(TransferError::Cancelled);
        }
    }
    Ok(())
}

/// Copies remote items (files or whole folders) into `dest`; returns the top-level
/// items created, renamed "name 2" if taken.
pub async fn download<F: FnMut(u64) -> bool>(
    sources: &[String],
    dest: &Path,
    tick: &mut F,
) -> Result<Vec<PathBuf>, TransferError> {
    let mut created = Vec::new();
    for source in sources {
        let (op, inner) = resolve(source)
            .map_err(|e| TransferError::Local(std::io::Error::other(e.to_string()), dest.to_path_buf()))?;
        let name = inner.rsplit('/').next().unwrap_or("download").to_owned();
        let target = unique(dest, &name);
        let dir = format!("{inner}/");
        if op.stat(&dir).await.is_ok_and(|m| m.is_dir()) {
            std::fs::create_dir_all(&target).map_err(|e| TransferError::Local(e, target.clone()))?;
            let all = op.list_with(&dir).recursive(true).await.map_err(TransferError::Remote)?;
            for e in all {
                let Some(rel) = e.path().strip_prefix(&dir) else { continue };
                if rel.is_empty() || rel.split('/').any(|c| c == "..") {
                    continue;
                }
                let local = target.join(rel.trim_end_matches('/'));
                if e.metadata().is_dir() {
                    std::fs::create_dir_all(&local).map_err(|er| TransferError::Local(er, local.clone()))?;
                } else {
                    if let Some(p) = local.parent() {
                        std::fs::create_dir_all(p).map_err(|er| TransferError::Local(er, p.to_path_buf()))?;
                    }
                    download_file(&op, e.path(), &local, tick).await?;
                }
            }
        } else {
            download_file(&op, &inner, &target, tick).await?;
        }
        created.push(target);
    }
    Ok(created)
}

/// Uploads local files or folders into the remote folder `dest`.
pub async fn upload<F: FnMut(u64) -> bool>(
    sources: &[PathBuf],
    dest: &str,
    tick: &mut F,
) -> Result<Vec<String>, TransferError> {
    let (op, inner) = resolve(dest)
        .map_err(|e| TransferError::Local(std::io::Error::other(e.to_string()), PathBuf::from(dest)))?;
    let base = dir_key(&inner);
    let mut created = Vec::new();
    for src in sources {
        let name = src.file_name().map_or_else(|| "upload".to_owned(), |n| n.to_string_lossy().into_owned());
        let top = format!("{base}{name}");
        let walker = walk(src).map_err(|e| TransferError::Local(e, src.clone()))?;
        for (path, rel, is_dir) in walker {
            let key = if rel.is_empty() { top.clone() } else { format!("{top}/{rel}") };
            if is_dir {
                op.create_dir(&format!("{key}/")).await.map_err(TransferError::Remote)?;
                continue;
            }
            let mut file = std::fs::File::open(&path).map_err(|e| TransferError::Local(e, path.clone()))?;
            let mut writer = op.writer(&key).await.map_err(TransferError::Remote)?;
            let mut buf = vec![0u8; usize::try_from(CHUNK).unwrap_or(1 << 22)];
            loop {
                let n = std::io::Read::read(&mut file, &mut buf)
                    .map_err(|e| TransferError::Local(e, path.clone()))?;
                if n == 0 {
                    break;
                }
                writer.write(buf[..n].to_vec()).await.map_err(TransferError::Remote)?;
                if !tick(n as u64) {
                    let _ = writer.abort().await;
                    return Err(TransferError::Cancelled);
                }
            }
            writer.close().await.map_err(TransferError::Remote)?;
        }
        created.push(virtual_path(id_of(dest), &top));
    }
    Ok(created)
}

/// `src` and everything below it: (path, path relative to `src`, is a folder).
fn walk(src: &Path) -> std::io::Result<Vec<(PathBuf, String, bool)>> {
    let mut out = Vec::new();
    fn go(p: &Path, rel: String, out: &mut Vec<(PathBuf, String, bool)>) -> std::io::Result<()> {
        let meta = std::fs::symlink_metadata(p)?;
        if meta.file_type().is_symlink() {
            return Ok(());
        }
        out.push((p.to_path_buf(), rel.clone(), meta.is_dir()));
        if meta.is_dir() {
            for e in std::fs::read_dir(p)?.filter_map(Result::ok) {
                let name = e.file_name().to_string_lossy().into_owned();
                if name == ".DS_Store" {
                    continue;
                }
                go(&e.path(), if rel.is_empty() { name } else { format!("{rel}/{name}") }, out)?;
            }
        }
        Ok(())
    }
    go(src, String::new(), &mut out)?;
    Ok(out)
}

/// Bytes a transfer will move, for the progress bar.
pub async fn remote_size(sources: &[String]) -> u64 {
    let mut total = 0;
    for s in sources {
        let Ok((op, inner)) = resolve(s) else { continue };
        let dir = format!("{inner}/");
        if op.stat(&dir).await.is_ok_and(|m| m.is_dir()) {
            if let Ok(all) = op.list_with(&dir).recursive(true).await {
                total += all.iter().map(|e| e.metadata().content_length()).sum::<u64>();
            }
        } else if let Ok(m) = op.stat(&inner).await {
            total += m.content_length();
        }
    }
    total
}

fn unique(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if first.symlink_metadata().is_err() {
        return first;
    }
    (2..).map(|n| dir.join(format!("{name} {n}"))).find(|p| p.symlink_metadata().is_err()).unwrap_or(first)
}

/// Dev builds only: serves a local folder as connection `id`, so the in-app
/// self-test can exercise remote browsing without a server.
#[tauri::command]
#[specta::specta]
pub fn remote_register_test_folder(id: String, root: String) -> AppResult<()> {
    if !cfg!(debug_assertions) {
        return Err(AppError::InvalidPath { path: root, reason: "only in development builds".into() });
    }
    let root = crate::security::validate_path(&root)?;
    let op = Operator::new(services::Fs::default().root(&root.to_string_lossy()))
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    if let Ok(mut m) = OPERATORS.lock() {
        m.insert(id, op);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn register_test_operator(id: &str, op: Operator) {
    if let Ok(mut m) = OPERATORS.lock() {
        m.insert(id.to_owned(), op);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The local file system through OpenDAL stands in for a server.
    fn fake_remote(id: &str) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let op = Operator::new(services::Fs::default().root(&tmp.path().to_string_lossy())).unwrap();
        register_test_operator(id, op);
        tmp
    }

    #[test]
    fn lists_uploads_downloads_renames_and_deletes() {
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t1");
            std::fs::create_dir_all(server.path().join("docs/deep")).unwrap();
            std::fs::write(server.path().join("docs/deep/a.txt"), "alpha").unwrap();
            std::fs::write(server.path().join("readme.md"), "hello").unwrap();

            let top = remote_list("remote:t1/".into()).await.unwrap();
            let names: Vec<_> = top.iter().map(|e| (e.name.as_str(), e.kind)).collect();
            assert_eq!(names.len(), 2, "only the children, not the folder itself: {names:?}");
            let inside = remote_list("remote:t1/docs".into()).await.unwrap();
            assert_eq!(inside.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["deep"]);
            assert!(names.contains(&("docs", EntryKind::Dir)), "{names:?}");
            assert!(names.contains(&("readme.md", EntryKind::File)), "{names:?}");
            assert_eq!(top.iter().find(|e| e.name == "readme.md").unwrap().path, "remote:t1/readme.md");

            // Download a folder.
            let local = tempfile::tempdir().unwrap();
            let mut moved = 0;
            let got = download(&["remote:t1/docs".into()], local.path(), &mut |n| {
                moved += n;
                true
            })
            .await
            .ok()
            .unwrap();
            assert_eq!(got, vec![local.path().join("docs")]);
            assert_eq!(std::fs::read_to_string(local.path().join("docs/deep/a.txt")).unwrap(), "alpha");
            assert_eq!(moved, 5);

            // Upload a folder back under another parent.
            remote_create_dir("remote:t1/".into(), "incoming".into()).await.unwrap();
            let up =
                upload(&[local.path().join("docs")], "remote:t1/incoming", &mut |_| true).await.ok().unwrap();
            assert_eq!(up, vec!["remote:t1/incoming/docs".to_owned()]);
            assert!(server.path().join("incoming/docs/deep/a.txt").exists());

            let renamed = remote_rename("remote:t1/readme.md".into(), "README.md".into()).await.unwrap();
            assert_eq!(renamed, "remote:t1/README.md");
            assert!(server.path().join("README.md").exists());

            remote_delete(vec!["remote:t1/incoming".into(), "remote:t1/README.md".into()]).await.unwrap();
            assert!(!server.path().join("incoming").exists());
            assert!(!server.path().join("README.md").exists());
            assert!(remote_delete(vec!["remote:t1/".into()]).await.is_err());
        });
    }

    #[test]
    fn cancelling_a_download_removes_the_partial_file() {
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t2");
            std::fs::write(server.path().join("big.bin"), vec![0u8; 10]).unwrap();
            let local = tempfile::tempdir().unwrap();
            let r = download(&["remote:t2/big.bin".into()], local.path(), &mut |_| false).await;
            assert!(matches!(r, Err(TransferError::Cancelled)));
            assert!(!local.path().join("big.bin").exists());
        });
    }

    #[test]
    fn rejects_traversal() {
        assert!(resolve("remote:x/../etc").is_err());
        assert!(resolve("/plain").is_err());
    }
}
