use std::io;
use std::path::Path;

use serde::Serialize;

/// Every command returns `Result<T, AppError>`; the frontend switches on `kind`.
#[derive(Debug, Clone, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppError {
    #[error("not found: {path}")]
    NotFound { path: String },
    #[error("permission denied: {path}")]
    #[serde(rename_all = "camelCase")]
    PermissionDenied {
        path: String,
        /// macOS TCC refusals surface as EPERM; EACCES is a plain unix permission problem.
        needs_full_disk_access: bool,
    },
    #[error("already exists: {path}")]
    AlreadyExists { path: String },
    #[error("not a directory: {path}")]
    NotADirectory { path: String },
    #[error("invalid path: {path} ({reason})")]
    InvalidPath { path: String, reason: String },
    #[error("cancelled")]
    Cancelled,
    #[error("{message}")]
    Io { path: Option<String>, message: String },
}

impl AppError {
    pub fn from_io(err: &io::Error, path: &Path) -> Self {
        let path = path.to_string_lossy().into_owned();
        match err.kind() {
            io::ErrorKind::NotFound => Self::NotFound { path },
            io::ErrorKind::PermissionDenied => Self::PermissionDenied {
                path,
                needs_full_disk_access: err.raw_os_error() == Some(libc::EPERM),
            },
            io::ErrorKind::AlreadyExists => Self::AlreadyExists { path },
            io::ErrorKind::NotADirectory => Self::NotADirectory { path },
            _ => Self::Io { path: Some(path), message: err.to_string() },
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_io_kinds() {
        let p = Path::new("/x");
        let nf = io::Error::from(io::ErrorKind::NotFound);
        assert!(matches!(AppError::from_io(&nf, p), AppError::NotFound { .. }));

        let eperm = io::Error::from_raw_os_error(libc::EPERM);
        assert!(matches!(
            AppError::from_io(&eperm, p),
            AppError::PermissionDenied { needs_full_disk_access: true, .. }
        ));

        let eacces = io::Error::from_raw_os_error(libc::EACCES);
        assert!(matches!(
            AppError::from_io(&eacces, p),
            AppError::PermissionDenied { needs_full_disk_access: false, .. }
        ));
    }

    #[test]
    fn serializes_tagged() {
        let json = serde_json::to_value(AppError::NotFound { path: "/a".into() }).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "notFound", "path": "/a" }));
    }
}
