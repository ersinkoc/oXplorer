//! Finder-compatible naming for new, duplicated and conflicting items.

use std::path::{Path, PathBuf};

/// Splits off the extension Finder would keep at the end: files and packages
/// only, and never a leading-dot name like `.env`.
fn split(name: &str, has_extension: bool) -> (&str, &str) {
    if !has_extension {
        return (name, "");
    }
    match name.rfind('.') {
        Some(i) if i > 0 && i < name.len() - 1 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

fn exists(p: &Path) -> bool {
    p.symlink_metadata().is_ok()
}

fn first_free(dir: &Path, candidates: impl Iterator<Item = String>) -> PathBuf {
    candidates.map(|n| dir.join(n)).find(|p| !exists(p)).expect("candidate names are unbounded")
}

/// "Keep Both": `report.pdf` → `report 2.pdf`, `report 3.pdf`, …
pub fn keep_both(dir: &Path, name: &str, has_extension: bool) -> PathBuf {
    let (stem, ext) = split(name, has_extension);
    first_free(dir, (2..).map(|n| format!("{stem} {n}{ext}")))
}

/// "Duplicate": `report.pdf` → `report copy.pdf`, `report copy 2.pdf`, …
pub fn duplicate(dir: &Path, name: &str, has_extension: bool) -> PathBuf {
    let (stem, ext) = split(name, has_extension);
    first_free(
        dir,
        std::iter::once(format!("{stem} copy{ext}")).chain((2..).map(|n| format!("{stem} copy {n}{ext}"))),
    )
}

/// New items: `untitled folder`, `untitled folder 2`, …
pub fn untitled(dir: &Path, name: &str, has_extension: bool) -> PathBuf {
    let (stem, ext) = split(name, has_extension);
    first_free(dir, std::iter::once(name.to_owned()).chain((2..).map(|n| format!("{stem} {n}{ext}"))))
}

/// A single path component the user typed; rejects anything that could escape the folder.
pub fn validate_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() {
        Err("the name can’t be empty")
    } else if name == "." || name == ".." {
        Err("“.” and “..” are reserved")
    } else if name.contains('/') || name.contains('\0') {
        Err("the name can’t contain “/”")
    } else if name.len() > 255 {
        Err("the name is too long")
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn finder_style_names() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        fs::write(d.join("a.txt"), "").unwrap();
        assert_eq!(keep_both(d, "a.txt", true), d.join("a 2.txt"));
        fs::write(d.join("a 2.txt"), "").unwrap();
        assert_eq!(keep_both(d, "a.txt", true), d.join("a 3.txt"));

        assert_eq!(duplicate(d, "a.txt", true), d.join("a copy.txt"));
        fs::write(d.join("a copy.txt"), "").unwrap();
        assert_eq!(duplicate(d, "a.txt", true), d.join("a copy 2.txt"));

        // Folders keep dots in their names; dotfiles have no extension.
        assert_eq!(duplicate(d, "v1.2", false), d.join("v1.2 copy"));
        assert_eq!(duplicate(d, ".env", true), d.join(".env copy"));

        assert_eq!(untitled(d, "untitled folder", false), d.join("untitled folder"));
        fs::create_dir(d.join("untitled folder")).unwrap();
        assert_eq!(untitled(d, "untitled folder", false), d.join("untitled folder 2"));
    }

    #[test]
    fn validates_names() {
        assert!(validate_name("ok.txt").is_ok());
        for bad in ["", ".", "..", "a/b", "a\0b"] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_name(&"x".repeat(256)).is_err());
    }
}
