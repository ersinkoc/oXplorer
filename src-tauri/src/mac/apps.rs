//! Applications that can open a file ("Open With").

use std::path::Path;

use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSString, NSURL};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    pub is_default: bool,
}

pub fn apps_for(path: &Path) -> Vec<AppInfo> {
    autoreleasepool(|_| {
        let ws = NSWorkspace::sharedWorkspace();
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let default = ws.URLForApplicationToOpenURL(&url).and_then(|u| u.path()).map(|p| p.to_string());
        let mut apps: Vec<AppInfo> = ws
            .URLsForApplicationsToOpenURL(&url)
            .iter()
            .filter_map(|u| u.path().map(|p| p.to_string()))
            .map(|p| AppInfo {
                name: Path::new(&p).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                is_default: default.as_deref() == Some(p.as_str()),
                path: p,
            })
            .collect();
        // Default first, then alphabetical; the same app can be installed twice.
        apps.sort_by(|a, b| {
            b.is_default.cmp(&a.is_default).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        apps.dedup_by(|a, b| a.path == b.path);
        apps
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_files_have_an_editor() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("x.txt");
        std::fs::write(&f, "hi").unwrap();
        let apps = apps_for(&f);
        assert!(!apps.is_empty());
        assert!(apps[0].is_default, "{apps:?}");
    }
}
