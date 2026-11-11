//! Remote folders (SFTP, FTP, WebDAV, S3) through OpenDAL, browsed under
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
    Ftp,
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
    /// SFTP: `host` or `host:port`. FTP: `host[:port]`, or `ftps://…` for TLS.
    /// WebDAV: the server URL. S3: a custom endpoint (empty for AWS).
    pub host: String,
    /// SFTP / FTP / WebDAV user, or the S3 access key id.
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
        RemoteKind::Ftp => {
            // A bare host means plain FTP; `ftps://` is explicit TLS.
            let endpoint = if conn.host.contains("://") {
                conn.host.clone()
            } else {
                format!("ftp://{}", prefer_ipv4(&conn.host))
            };
            let mut b = services::Ftp::default().endpoint(&endpoint).root(root);
            if !conn.user.is_empty() {
                b = b.user(&conn.user);
            }
            if let Some(s) = secret {
                b = b.password(s);
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

/// The FTP client opens data connections with PASV, which fails when the
/// control connection went over IPv6, so plain FTP connects over IPv4 when the
/// host has an IPv4 address. (FTPS keeps the name for certificate checks.)
fn prefer_ipv4(host: &str) -> String {
    use std::net::ToSocketAddrs as _;
    let with_port = if host.contains(':') { host.to_owned() } else { format!("{host}:21") };
    with_port
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.find(std::net::SocketAddr::is_ipv4))
        .map_or_else(|| host.to_owned(), |a| a.to_string())
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
pub async fn remote_save_secret(id: String, secret: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || save_secret(&id, &secret))
        .await
        .map_err(|e| AppError::Io { path: None, message: e.to_string() })?
}

fn save_secret(id: &str, secret: &str) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::{delete_generic_password, set_generic_password};
        let r = if secret.is_empty() {
            delete_generic_password(KEYCHAIN_SERVICE, id).or(Ok(()))
        } else {
            set_generic_password(KEYCHAIN_SERVICE, id, secret.as_bytes())
        };
        r.map_err(|e: security_framework::base::Error| AppError::Io { path: None, message: e.to_string() })?;
    }
    if let Ok(mut m) = OPERATORS.lock() {
        m.remove(id);
    }
    Ok(())
}

/// Whether a password / secret key is stored for the connection.
#[tauri::command]
#[specta::specta]
pub async fn remote_has_secret(id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || secret(&id).is_some()).await.unwrap_or(false)
}

/// Tries to list the top of a connection (with an unsaved secret, if given).
#[tauri::command]
#[specta::specta]
pub async fn remote_test(connection: Connection, secret_override: Option<String>) -> AppResult<()> {
    // The stored secret only goes to the server it was saved for (an edited
    // host must not receive it); otherwise the password has to be typed again.
    let saved_for_this =
        CONNECTIONS.lock().ok().and_then(|m| m.get(&connection.id).cloned()).is_some_and(|c| {
            c.kind == connection.kind
                && c.host == connection.host
                && c.user == connection.user
                && c.bucket == connection.bucket
        });
    let stored = if saved_for_this {
        let id = connection.id.clone();
        tauri::async_runtime::spawn_blocking(move || secret(&id)).await.ok().flatten()
    } else {
        None
    };
    let s = secret_override.filter(|s| !s.is_empty()).or(stored);
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
    if to == inner {
        return Ok(path);
    }
    // Never onto another item. A change of letter case only is fine unless the
    // server tells the two names apart (both are listed).
    let err = |e: opendal::Error| remote_err(&path, &e);
    if taken(&op, &to).await.map_err(err)? {
        let case_only = to.to_lowercase() == inner.to_lowercase();
        let listed = || async {
            let all = op.list(&dir_key(parent)).await?;
            Ok::<_, opendal::Error>(all.iter().any(|e| e.name().trim_end_matches('/') == new_name))
        };
        if !case_only || listed().await.map_err(err)? {
            return Err(AppError::AlreadyExists { path: virtual_path(id_of(&path), &to) });
        }
    }
    // Folders too go without a trailing slash: OpenDAL refuses one in a rename.
    op.rename(&inner, &to).await.map_err(err)?;
    Ok(virtual_path(id_of(&path), &to))
}

/// Whether the server has a file or folder at `key`.
async fn taken(op: &Operator, key: &str) -> opendal::Result<bool> {
    Ok(op.exists(key).await? || op.exists(&format!("{key}/")).await?)
}

/// `{base}{name}`, or "name 2.ext", "name 3.ext", … if the server has it (Keep Both).
async fn free_key(op: &Operator, base: &str, name: &str, is_dir: bool) -> opendal::Result<String> {
    let (stem, ext) = crate::jobs::names::split(name, !is_dir);
    let mut key = format!("{base}{name}");
    let mut n = 1;
    while taken(op, &key).await? {
        n += 1;
        key = format!("{base}{stem} {n}{ext}");
    }
    Ok(key)
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
    let base = app.path().app_cache_dir().map_err(|e| AppError::Io { path: None, message: e.to_string() })?;
    open_member(&base, &path, &mut |_| true).await
}

async fn open_member<F: FnMut(u64) -> bool>(base: &Path, path: &str, tick: &mut F) -> AppResult<String> {
    let (op, inner) = resolve(path)?;
    let name = inner.rsplit('/').next().unwrap_or("file").to_owned();
    let dir = base.join("remote-open").join(id_of(path)).join(inner.replace('/', "_"));
    std::fs::create_dir_all(&dir).map_err(|e| AppError::from_io(&e, &dir))?;
    let out = dir.join(&name);
    // Into a name of its own, then over `out` in one step: whoever opened this
    // file a moment ago may still be reading the copy there.
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let part = dir.join(format!(".{name}.{n}.oxpart"));
    download_file(&op, &inner, &part, tick).await.map_err(|e| e.into_app(path))?;
    std::fs::rename(&part, &out).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        AppError::from_io(&e, &out)
    })?;
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
    let copied = async {
        let mut offset = 0;
        while offset < size {
            let end = (offset + CHUNK).min(size);
            let buf = reader.read(offset..end).await.map_err(TransferError::Remote)?;
            file.write_all(&buf.to_vec()).map_err(|e| TransferError::Local(e, out.to_path_buf()))?;
            offset = end;
            if !tick(buf.len() as u64) {
                return Err(TransferError::Cancelled);
            }
        }
        Ok(())
    }
    .await;
    // Stopped or failed: no partial file under the final name.
    if copied.is_err() {
        drop(file);
        let _ = std::fs::remove_file(out);
    }
    copied
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
        let name = inner.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("download").to_owned();
        let dir = format!("{inner}/");
        let is_dir = op.stat(&dir).await.is_ok_and(|m| m.is_dir());
        let free = dest.join(&name);
        let target = if free.symlink_metadata().is_err() {
            free
        } else {
            crate::jobs::names::keep_both(dest, &name, !is_dir)
        };
        if is_dir {
            std::fs::create_dir_all(&target).map_err(|e| TransferError::Local(e, target.clone()))?;
            let all = op.list_with(&dir).recursive(true).await.map_err(TransferError::Remote)?;
            for e in all {
                let Some(rel) = e.path().strip_prefix(&dir).and_then(local_rel) else { continue };
                let local = target.join(rel);
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
        let walker = walk(src).map_err(|e| TransferError::Local(e, src.clone()))?;
        let is_dir = walker.first().is_some_and(|(_, _, d)| *d);
        // Never over what the server has: it has no Trash to get it back from.
        let top = free_key(&op, &base, &name, is_dir).await.map_err(TransferError::Remote)?;
        for (path, rel, is_dir) in walker {
            let key = if rel.is_empty() { top.clone() } else { format!("{top}/{rel}") };
            if is_dir {
                op.create_dir(&format!("{key}/")).await.map_err(TransferError::Remote)?;
                continue;
            }
            let sent = send_file(&op, &path, &key, tick).await;
            // Stopped or failed: no partial file left on the server (the name was free).
            if sent.is_err() {
                let _ = op.delete(&key).await;
            }
            sent?;
        }
        created.push(virtual_path(id_of(dest), &top));
    }
    Ok(created)
}

async fn send_file<F: FnMut(u64) -> bool>(
    op: &Operator,
    path: &Path,
    key: &str,
    tick: &mut F,
) -> Result<(), TransferError> {
    let local = |e| TransferError::Local(e, path.to_path_buf());
    let mut file = std::fs::File::open(path).map_err(local)?;
    let mut writer = op.writer(key).await.map_err(TransferError::Remote)?;
    let mut buf = vec![0u8; usize::try_from(CHUNK).unwrap_or(1 << 22)];
    let sent = async {
        loop {
            let n = std::io::Read::read(&mut file, &mut buf).map_err(local)?;
            if n == 0 {
                return Ok(());
            }
            writer.write(buf[..n].to_vec()).await.map_err(TransferError::Remote)?;
            if !tick(n as u64) {
                return Err(TransferError::Cancelled);
            }
        }
    }
    .await;
    match sent {
        Ok(()) => writer.close().await.map(|_| ()).map_err(TransferError::Remote),
        Err(e) => {
            let _ = writer.abort().await;
            Err(e)
        }
    }
}

/// `src` and everything below it: (path, path relative to `src`, is a folder).
/// A server can't hold links, so a link sends what it points at; a broken link
/// inside a folder is left out, and a link to a folder it sits in isn't entered again.
fn walk(src: &Path) -> std::io::Result<Vec<(PathBuf, String, bool)>> {
    use std::os::unix::fs::MetadataExt as _;
    type Out = Vec<(PathBuf, String, bool)>;
    fn go(p: &Path, rel: String, above: &mut Vec<(u64, u64)>, out: &mut Out) -> std::io::Result<()> {
        let meta = match std::fs::metadata(p) {
            Ok(m) => m,
            Err(e) if !rel.is_empty() && std::fs::symlink_metadata(p).is_ok_and(|m| m.is_symlink()) => {
                log::warn!("upload: left out the broken link {} ({e})", p.display());
                return Ok(());
            }
            Err(e) => return Err(e),
        };
        if !meta.is_dir() {
            out.push((p.to_path_buf(), rel, false));
            return Ok(());
        }
        let id = (meta.dev(), meta.ino());
        if above.contains(&id) {
            return Ok(());
        }
        out.push((p.to_path_buf(), rel.clone(), true));
        above.push(id);
        for e in std::fs::read_dir(p)?.filter_map(Result::ok) {
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".DS_Store" {
                continue;
            }
            go(&e.path(), if rel.is_empty() { name } else { format!("{rel}/{name}") }, above, out)?;
        }
        above.pop();
        Ok(())
    }
    let mut out = Vec::new();
    go(src, String::new(), &mut Vec::new(), &mut out)?;
    Ok(out)
}

/// Bytes and items an upload sends, for the progress bar: links count as what
/// they point at, as `walk` sends them.
pub fn upload_size(sources: &[PathBuf]) -> (u64, u32) {
    let mut total = (0, 0);
    for (path, _, is_dir) in sources.iter().flat_map(|s| walk(s).unwrap_or_default()) {
        total.1 += 1;
        if !is_dir {
            total.0 += std::fs::metadata(&path).map_or(0, |m| m.len());
        }
    }
    total
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

/// A server-supplied key below the downloaded folder, as a relative local path made
/// of plain names only. Keys like `a//Users/me/.zshrc` (legal on S3) would otherwise
/// turn into an absolute path that `join` lets replace the target folder.
fn local_rel(rel: &str) -> Option<&Path> {
    let rel = Path::new(rel.trim_end_matches('/'));
    let mut parts = rel.components();
    let plain = parts.clone().all(|c| matches!(c, std::path::Component::Normal(_)));
    (plain && parts.next().is_some()).then_some(rel)
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

    /// Needs the network: anonymous FTP against a public mirror.
    #[test]
    #[ignore = "network"]
    fn ftp_lists_a_public_server() {
        tauri::async_runtime::block_on(async {
            let conn = Connection {
                id: "ftp1".into(),
                name: "GNU".into(),
                kind: RemoteKind::Ftp,
                host: "ftp.gnu.org".into(),
                user: "anonymous".into(),
                root: "/gnu".into(),
                bucket: String::new(),
                region: String::new(),
            };
            register_test_operator("ftp1", build(&conn, Some("anonymous@")).unwrap());
            let top = remote_list("remote:ftp1/".into()).await.unwrap();
            assert!(top.iter().any(|e| e.name == "bash" && e.kind == EntryKind::Dir), "{top:?}");
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
    fn an_upload_never_replaces_what_the_server_has() {
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t3");
            let s = server.path();
            std::fs::write(s.join("keep.txt"), "server copy").unwrap();
            std::fs::create_dir_all(s.join("docs")).unwrap();
            std::fs::write(s.join("docs/a.txt"), "server a").unwrap();
            let local = tempfile::tempdir().unwrap();
            let l = local.path();
            std::fs::write(l.join("keep.txt"), "local copy").unwrap();
            std::fs::write(l.join("fresh.txt"), "new").unwrap();
            std::fs::create_dir_all(l.join("docs")).unwrap();
            std::fs::write(l.join("docs/a.txt"), "local a").unwrap();

            // Control: a name the server doesn't have keeps its name.
            let up =
                upload(&[l.join("fresh.txt"), l.join("keep.txt"), l.join("docs")], "remote:t3/", &mut |_| {
                    true
                })
                .await
                .ok()
                .unwrap();
            assert_eq!(std::fs::read_to_string(s.join("fresh.txt")).unwrap(), "new");
            assert_eq!(std::fs::read_to_string(s.join("keep.txt")).unwrap(), "server copy");
            assert_eq!(std::fs::read_to_string(s.join("docs/a.txt")).unwrap(), "server a");
            assert_eq!(up, ["remote:t3/fresh.txt", "remote:t3/keep 2.txt", "remote:t3/docs 2"]);
            assert_eq!(std::fs::read_to_string(s.join("keep 2.txt")).unwrap(), "local copy");
            assert_eq!(std::fs::read_to_string(s.join("docs 2/a.txt")).unwrap(), "local a");

            // A stopped upload leaves nothing half-written behind.
            std::fs::write(l.join("big.bin"), vec![7u8; 6 << 20]).unwrap();
            let r = upload(&[l.join("big.bin")], "remote:t3/", &mut |_| false).await;
            assert!(matches!(r, Err(TransferError::Cancelled)));
            assert!(!s.join("big.bin").exists(), "a partial upload was left on the server");
            // Stopped after the first chunk of a bigger file, inside a folder.
            std::fs::create_dir_all(l.join("pack")).unwrap();
            std::fs::write(l.join("pack/huge.bin"), vec![7u8; 9 << 20]).unwrap();
            let mut calls = 0;
            let r = upload(&[l.join("pack")], "remote:t3/", &mut |_| {
                calls += 1;
                calls < 2
            })
            .await;
            assert!(matches!(r, Err(TransferError::Cancelled)));
            assert!(!s.join("pack/huge.bin").exists(), "a partial upload was left on the server");
            // The next free name, and names without an extension.
            let up = upload(&[l.join("keep.txt")], "remote:t3/", &mut |_| true).await.ok().unwrap();
            assert_eq!(up, ["remote:t3/keep 3.txt"]);
            std::fs::write(s.join(".env"), "server").unwrap();
            std::fs::write(l.join(".env"), "local").unwrap();
            let up = upload(&[l.join(".env")], "remote:t3/", &mut |_| true).await.ok().unwrap();
            assert_eq!(up, ["remote:t3/.env 2"]);
            assert_eq!(std::fs::read_to_string(s.join(".env")).unwrap(), "server");
        });
    }

    #[test]
    fn a_rename_never_replaces_another_item() {
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t4");
            let s = server.path();
            std::fs::write(s.join("a.txt"), "A").unwrap();
            std::fs::write(s.join("b.txt"), "B").unwrap();
            let r = remote_rename("remote:t4/a.txt".into(), "b.txt".into()).await;
            assert!(matches!(r, Err(AppError::AlreadyExists { .. })), "{r:?}");
            assert_eq!(std::fs::read_to_string(s.join("b.txt")).unwrap(), "B");
            assert_eq!(std::fs::read_to_string(s.join("a.txt")).unwrap(), "A");
            // The same name changes nothing.
            assert_eq!(
                remote_rename("remote:t4/a.txt".into(), "a.txt".into()).await.unwrap(),
                "remote:t4/a.txt"
            );
            // Control: a free name, and a change of letter case only.
            assert_eq!(
                remote_rename("remote:t4/a.txt".into(), "c.txt".into()).await.unwrap(),
                "remote:t4/c.txt"
            );
            assert_eq!(
                remote_rename("remote:t4/c.txt".into(), "C.txt".into()).await.unwrap(),
                "remote:t4/C.txt"
            );
            let names: Vec<_> = std::fs::read_dir(s).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert!(names.contains(&"C.txt".into()), "{names:?}");
        });
    }

    #[test]
    fn folders_on_a_server_can_be_renamed() {
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t5");
            let s = server.path();
            std::fs::create_dir_all(s.join("docs")).unwrap();
            std::fs::write(s.join("docs/x.txt"), "x").unwrap();
            std::fs::create_dir_all(s.join("other")).unwrap();
            let r = remote_rename("remote:t5/docs".into(), "docs2".into()).await;
            assert_eq!(r.ok().as_deref(), Some("remote:t5/docs2"));
            assert_eq!(std::fs::read_to_string(s.join("docs2/x.txt")).unwrap(), "x");
            // Not onto another folder.
            assert!(remote_rename("remote:t5/docs2".into(), "other".into()).await.is_err());
            assert!(s.join("docs2/x.txt").exists());
        });
    }

    #[test]
    fn a_failed_download_leaves_no_partial_file() {
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t6");
            let src = server.path().join("grow.bin");
            std::fs::write(&src, vec![1u8; 9 << 20]).unwrap();
            let local = tempfile::tempdir().unwrap();
            // Control: an undisturbed download.
            assert!(download(&["remote:t6/grow.bin".into()], local.path(), &mut |_| true).await.is_ok());
            assert_eq!(std::fs::metadata(local.path().join("grow.bin")).unwrap().len(), 9 << 20);
            std::fs::remove_file(local.path().join("grow.bin")).unwrap();

            // The server file shrinks after the first chunk: the read fails.
            let r = download(&["remote:t6/grow.bin".into()], local.path(), &mut |_| {
                std::fs::File::options().write(true).open(&src).unwrap().set_len(10).unwrap();
                true
            })
            .await;
            assert!(r.is_err());
            let left: Vec<_> =
                std::fs::read_dir(local.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert!(left.is_empty(), "a partial download was left: {left:?}");

            // Inside a folder download: the member that failed is gone, the error reaches the caller.
            std::fs::create_dir_all(server.path().join("set")).unwrap();
            std::fs::write(server.path().join("set/grow.bin"), vec![1u8; 9 << 20]).unwrap();
            let inner = server.path().join("set/grow.bin");
            let r = download(&["remote:t6/set".into()], local.path(), &mut |_| {
                std::fs::File::options().write(true).open(&inner).unwrap().set_len(10).unwrap();
                true
            })
            .await;
            assert!(matches!(r, Err(TransferError::Remote(_))));
            assert!(!local.path().join("set/grow.bin").exists(), "a partial download was left");
        });
    }

    #[test]
    fn a_download_keeps_the_extension_when_the_name_is_taken() {
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t7");
            std::fs::write(server.path().join("photo.jpg"), "new").unwrap();
            std::fs::create_dir_all(server.path().join("v1.2")).unwrap();
            let local = tempfile::tempdir().unwrap();
            let l = local.path();
            // Control: a free name.
            let got = download(&["remote:t7/photo.jpg".into()], l, &mut |_| true).await.ok().unwrap();
            assert_eq!(got, [l.join("photo.jpg")]);
            let got = download(&["remote:t7/photo.jpg".into(), "remote:t7/v1.2".into()], l, &mut |_| true)
                .await
                .ok()
                .unwrap();
            std::fs::create_dir_all(l.join("v1.2")).unwrap();
            assert_eq!(got[0], l.join("photo 2.jpg"));
            assert_eq!(got[1], l.join("v1.2"));
            let got = download(&["remote:t7/v1.2".into()], l, &mut |_| true).await.ok().unwrap();
            assert_eq!(got, [l.join("v1.2 2")]);
        });
    }

    #[test]
    fn server_keys_stay_inside_the_download() {
        assert_eq!(local_rel("a/b.txt"), Some(Path::new("a/b.txt")));
        assert_eq!(local_rel("sub/"), Some(Path::new("sub")));
        assert_eq!(local_rel("/Users/me/.zshrc"), None);
        assert_eq!(local_rel("a/../../x"), None);
        assert_eq!(local_rel("./x"), None);
        assert_eq!(local_rel(""), None);
    }

    #[test]
    fn rejects_traversal() {
        assert!(resolve("remote:x/../etc").is_err());
        assert!(resolve("/plain").is_err());
    }

    #[test]
    fn linked_items_are_uploaded_as_what_they_point_at() {
        use std::os::unix::fs::symlink;
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t8");
            let s = server.path();
            let local = tempfile::tempdir().unwrap();
            let l = local.path();
            std::fs::write(l.join("real.txt"), "data").unwrap();
            std::fs::create_dir_all(l.join("pack")).unwrap();
            std::fs::write(l.join("pack/plain.txt"), "plain").unwrap();
            symlink("../real.txt", l.join("pack/link.txt")).unwrap();
            symlink("real.txt", l.join("alias.txt")).unwrap();

            let up = upload(&[l.join("pack"), l.join("alias.txt")], "remote:t8/", &mut |_| true)
                .await
                .ok()
                .unwrap();
            // Control: a plain file inside the folder.
            assert_eq!(std::fs::read_to_string(s.join("pack/plain.txt")).unwrap(), "plain");
            let got = |p: &str| std::fs::read_to_string(s.join(p)).ok();
            println!("EXPECTED: pack/link.txt Some(\"data\"), alias.txt Some(\"data\")");
            println!("ACTUAL:   pack/link.txt {:?}, alias.txt {:?}", got("pack/link.txt"), got("alias.txt"));
            assert_eq!(got("pack/link.txt").as_deref(), Some("data"), "a linked file was left out");
            assert_eq!(
                got("alias.txt").as_deref(),
                Some("data"),
                "a link chosen itself was reported but not sent"
            );
            assert_eq!(up, ["remote:t8/pack", "remote:t8/alias.txt"]);

            // A linked folder sends its contents; a link to a folder it sits in isn't
            // entered again; a broken link inside is left out.
            std::fs::create_dir_all(l.join("elsewhere")).unwrap();
            std::fs::write(l.join("elsewhere/x.txt"), "x").unwrap();
            std::fs::create_dir_all(l.join("tree/sub")).unwrap();
            symlink("../elsewhere", l.join("tree/far")).unwrap();
            symlink("..", l.join("tree/sub/up")).unwrap();
            symlink("missing.txt", l.join("tree/broken.txt")).unwrap();
            let up = upload(&[l.join("tree")], "remote:t8/", &mut |_| true).await.ok().unwrap();
            assert_eq!(up, ["remote:t8/tree"]);
            assert_eq!(std::fs::read_to_string(s.join("tree/far/x.txt")).unwrap(), "x");
            assert!(s.join("tree/sub").is_dir());
            assert!(!s.join("tree/sub/up").exists(), "a link back up was entered again");
            assert!(!s.join("tree/broken.txt").exists());
            // A broken link chosen itself is an error, not an empty success.
            symlink("gone.txt", l.join("dangling.txt")).unwrap();
            let r = upload(&[l.join("dangling.txt")], "remote:t8/", &mut |_| true).await;
            assert!(matches!(r, Err(TransferError::Local(..))));
            assert!(!s.join("dangling.txt").exists());
        });
    }

    #[test]
    fn opening_a_server_file_again_leaves_the_copy_in_use_alone() {
        tauri::async_runtime::block_on(async {
            let server = fake_remote("t9");
            let size = 9 << 20;
            std::fs::write(server.path().join("movie.bin"), vec![5u8; size]).unwrap();
            std::fs::write(server.path().join("other.txt"), "other").unwrap();
            let cache = tempfile::tempdir().unwrap();
            let first = open_member(cache.path(), "remote:t9/movie.bin", &mut |_| true).await.unwrap();
            // Control: another file opens to its own copy.
            let other = open_member(cache.path(), "remote:t9/other.txt", &mut |_| true).await.unwrap();
            assert_eq!(std::fs::read_to_string(other).unwrap(), "other");

            // Opened again (preview pane and Quick Look at once) and stopped or failed
            // after the first chunk: the copy the first caller got stays whole.
            let mut during = None;
            let again = open_member(cache.path(), "remote:t9/movie.bin", &mut |_| {
                during.get_or_insert_with(|| std::fs::metadata(&first).map(|m| m.len()).ok());
                false
            })
            .await;
            assert!(again.is_err());
            let after = std::fs::metadata(&first).map(|m| m.len()).ok();
            println!("EXPECTED: during Some({size}), after Some({size})");
            println!("ACTUAL:   during {:?}, after {after:?}", during.flatten());
            assert_eq!(during.flatten(), Some(size as u64), "the first copy was cut short meanwhile");
            assert_eq!(after, Some(size as u64), "the first copy was removed");

            // Two opens at once: the second runs start to end while the first is
            // after its first chunk (gated in the first one's tick). Both get the whole file.
            let mut second = None;
            let first_again = open_member(cache.path(), "remote:t9/movie.bin", &mut |_| {
                if second.is_none() {
                    second = Some(std::thread::scope(|sc| {
                        sc.spawn(|| {
                            tauri::async_runtime::block_on(open_member(
                                cache.path(),
                                "remote:t9/movie.bin",
                                &mut |_| true,
                            ))
                        })
                        .join()
                        .unwrap()
                    }));
                }
                true
            })
            .await
            .unwrap();
            let second = second.unwrap().unwrap();
            assert_eq!(first_again, second);
            assert_eq!(std::fs::metadata(&second).unwrap().len(), size as u64);
            // No half-downloaded copies left next to it.
            let dir = Path::new(&second).parent().unwrap();
            let names: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert_eq!(names, ["movie.bin"]);
        });
    }
}
