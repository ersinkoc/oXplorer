//! Convert Image: a copy of a picture in another format and/or a smaller size,
//! made by macOS's `sips`, next to the original.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

use super::names;
use crate::error::AppError;

const SIPS: &str = "/usr/bin/sips";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ImageFormat {
    Jpeg,
    Png,
    Heic,
    Tiff,
}

impl ImageFormat {
    fn sips_name(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
            Self::Heic => "heic",
            Self::Tiff => "tiff",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Heic => "heic",
            Self::Tiff => "tiff",
        }
    }
}

/// Writes the converted copy of `src` and returns its path. `max_size` limits
/// the longer side in pixels (never enlarging).
pub fn convert(src: &Path, format: ImageFormat, max_size: Option<u32>) -> Result<PathBuf, AppError> {
    let dir = src.parent().unwrap_or(Path::new("/"));
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let dst = names::untitled(dir, &format!("{stem}.{}", format.extension()), true);
    let mut cmd = Command::new(SIPS);
    cmd.args(["-s", "format", format.sips_name()]);
    if let Some(px) = max_size {
        // -Z scales the longer side down to `px`, keeping the aspect ratio.
        if !fits(src, px) {
            cmd.arg("-Z").arg(px.to_string());
        }
    }
    let out = cmd.arg(src).arg("--out").arg(&dst).output().map_err(|e| AppError::Io {
        path: Some(src.to_string_lossy().into_owned()),
        message: e.to_string(),
    })?;
    if !out.status.success() || !dst.exists() {
        let _ = std::fs::remove_file(&dst);
        let message = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        return Err(AppError::Io {
            path: Some(src.to_string_lossy().into_owned()),
            message: if message.is_empty() { "the image couldn’t be converted".into() } else { message },
        });
    }
    Ok(dst)
}

/// Whether both sides of the picture are at most `px` (sips -Z would enlarge it).
fn fits(src: &Path, px: u32) -> bool {
    let Ok(out) = Command::new(SIPS).args(["-g", "pixelWidth", "-g", "pixelHeight"]).arg(src).output() else {
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let sides: Vec<u32> = text
        .lines()
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| k.trim().starts_with("pixel"))
        .filter_map(|(_, v)| v.trim().parse().ok())
        .collect();
    sides.len() == 2 && sides.iter().all(|&s| s <= px)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    /// A 4×2 red PNG.
    fn png(path: &Path) {
        let ppm = path.with_extension("ppm");
        fs::write(&ppm, b"P6\n4 2\n255\n".iter().copied().chain([255u8, 0, 0].repeat(8)).collect::<Vec<_>>())
            .unwrap();
        let ok = Command::new(SIPS).args(["-s", "format", "png"]).arg(&ppm).arg("--out").arg(path).output();
        fs::remove_file(&ppm).unwrap();
        assert!(ok.unwrap().status.success());
    }

    fn size(p: &Path) -> (u32, u32) {
        let out = Command::new(SIPS).args(["-g", "pixelWidth", "-g", "pixelHeight"]).arg(p).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let v: Vec<u32> = text.lines().filter_map(|l| l.split_once(':')?.1.trim().parse().ok()).collect();
        (v[0], v[1])
    }

    #[test]
    fn converts_next_to_the_original_and_never_enlarges() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("red.png");
        png(&src);

        let jpg = convert(&src, ImageFormat::Jpeg, None).unwrap();
        assert_eq!(jpg, tmp.path().join("red.jpg"));
        assert_eq!(size(&jpg), (4, 2));
        // The name is taken now: the next one gets a number.
        let small = convert(&src, ImageFormat::Jpeg, Some(2)).unwrap();
        assert_eq!(small, tmp.path().join("red 2.jpg"));
        assert_eq!(size(&small), (2, 1));
        let same = convert(&src, ImageFormat::Png, Some(100)).unwrap();
        assert_eq!(same, tmp.path().join("red 2.png"));
        assert_eq!(size(&same), (4, 2));
    }

    #[test]
    fn reports_files_that_arent_images() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("notes.txt");
        fs::write(&src, b"hello").unwrap();
        assert!(convert(&src, ImageFormat::Png, None).is_err());
        assert!(!tmp.path().join("notes.png").exists());
    }
}
