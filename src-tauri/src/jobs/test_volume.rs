//! Tests only: a small exFAT disk image, mounted for the life of the value, to
//! exercise code paths that a single APFS volume never takes (no clones, no hard
//! links, cross-device renames).

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct OtherVolume {
    _image_dir: tempfile::TempDir,
    mount: PathBuf,
}

impl OtherVolume {
    /// `None` (test skipped) where hdiutil can't make or attach images.
    pub fn exfat() -> Option<Self> {
        let image_dir = tempfile::tempdir().ok()?;
        let image = image_dir.path().join("vol.dmg");
        let mount = image_dir.path().join("mnt");
        let ok = |c: &mut Command| c.output().is_ok_and(|o| o.status.success());
        let created = ok(Command::new("hdiutil")
            .args(["create", "-quiet", "-size", "16m", "-fs", "ExFAT", "-volname", "OXTEST"])
            .arg(&image));
        let attached = created
            && ok(Command::new("hdiutil")
                .args(["attach", "-quiet", "-nobrowse", "-mountpoint"])
                .arg(&mount)
                .arg(&image));
        if !attached {
            eprintln!("skipped: could not mount an exFAT image");
            return None;
        }
        Some(Self { _image_dir: image_dir, mount })
    }

    pub fn path(&self) -> &Path {
        &self.mount
    }
}

impl Drop for OtherVolume {
    fn drop(&mut self) {
        let _ = Command::new("hdiutil").args(["detach", "-quiet", "-force"]).arg(&self.mount).output();
    }
}
