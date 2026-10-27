use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Every path that crosses the IPC boundary goes through here first.
/// Paths must be absolute and free of `..` so that the frontend can't smuggle
/// traversal past whatever the UI showed the user.
pub fn validate_path(raw: &str) -> AppResult<PathBuf> {
    let invalid = |reason: &str| AppError::InvalidPath { path: raw.to_owned(), reason: reason.to_owned() };

    if raw.is_empty() {
        return Err(invalid("empty"));
    }
    if raw.contains('\0') {
        return Err(invalid("contains NUL"));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(invalid("not absolute"));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(invalid("contains '..'"));
    }
    // Drops `.` segments and duplicate separators.
    Ok(path.components().collect())
}

/// Locations where a recursive/permanent destructive operation is refused outright.
pub fn is_protected_root(path: &Path) -> bool {
    const SYSTEM: &[&str] = &[
        "/",
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "/var",
        "/private",
        "/Library",
        "/Applications",
        "/Users",
        "/Volumes",
    ];
    if SYSTEM.iter().any(|p| path == Path::new(p)) {
        return true;
    }
    dirs::home_dir().is_some_and(|home| path == home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_absolute() {
        assert_eq!(validate_path("/Users/a/./b//c").unwrap(), PathBuf::from("/Users/a/b/c"));
        assert_eq!(validate_path("/").unwrap(), PathBuf::from("/"));
    }

    #[test]
    fn rejects_bad_input() {
        for bad in ["", "relative/x", "/a/../etc", "/a/\0b", "~/x"] {
            assert!(validate_path(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn protected_roots() {
        assert!(is_protected_root(Path::new("/")));
        assert!(is_protected_root(Path::new("/System")));
        assert!(!is_protected_root(Path::new("/tmp/x")));
        if let Some(home) = dirs::home_dir() {
            assert!(is_protected_root(&home));
            assert!(!is_protected_root(&home.join("Desktop")));
        }
    }
}
