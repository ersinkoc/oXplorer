//! Builds that can't update themselves (no updater key, e.g. unsigned betas)
//! still learn about newer versions from the GitHub releases list.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

const RELEASES_URL: &str = "https://api.github.com/repos/ersinkoc/oXplorer/releases?per_page=30";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub version: String,
    /// The release page, where the DMG is.
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// The newest published release above this build, if any. Pre-releases only
/// count for pre-release builds (beta testers get betas, everyone else doesn't).
#[tauri::command]
#[specta::specta]
pub async fn newer_release(app: AppHandle) -> AppResult<Option<ReleaseInfo>> {
    let current = app.package_info().version.to_string();
    let releases = fetch(&current).await?;
    Ok(pick_newer(&current, &releases))
}

async fn fetch(current: &str) -> AppResult<Vec<GithubRelease>> {
    let net = |e: reqwest::Error| AppError::Io { path: None, message: e.to_string() };
    reqwest::Client::builder()
        .user_agent(format!("OXplorer/{current}"))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(net)?
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(net)?
        .error_for_status()
        .map_err(net)?
        .json()
        .await
        .map_err(net)
}

fn pick_newer(current: &str, releases: &[GithubRelease]) -> Option<ReleaseInfo> {
    let current = semver::Version::parse(current).ok()?;
    let betas = !current.pre.is_empty();
    releases
        .iter()
        .filter(|r| !r.draft && (betas || !r.prerelease))
        .filter_map(|r| {
            let v = semver::Version::parse(r.tag_name.trim_start_matches('v')).ok()?;
            (v > current).then_some((v, r))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(v, r)| ReleaseInfo { version: v.to_string(), url: r.html_url.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(tag: &str, prerelease: bool, draft: bool) -> GithubRelease {
        GithubRelease { tag_name: tag.into(), html_url: format!("https://x/{tag}"), draft, prerelease }
    }

    /// Network: `cargo test --lib releases -- --ignored`.
    #[test]
    #[ignore = "talks to api.github.com"]
    fn reads_the_real_release_list() {
        let list = tauri::async_runtime::block_on(fetch("0.0.0")).unwrap();
        assert!(list.iter().any(|r| r.tag_name == "v0.1.0-beta.2"), "{list:?}");
        assert!(pick_newer("0.1.0-beta.1", &list).is_some());
    }

    #[test]
    fn picks_the_newest_newer_release() {
        let list = [
            rel("v0.1.0-beta.2", true, false),
            rel("v0.1.0-beta.3", true, false),
            rel("v0.1.0-beta.4", true, true),
            rel("v0.1.0", false, false),
            rel("nonsense", false, false),
        ];
        // A beta sees later betas and the final release; the final one wins.
        assert_eq!(pick_newer("0.1.0-beta.2", &list).map(|r| r.version), Some("0.1.0".into()));
        assert_eq!(pick_newer("0.1.0-beta.2", &list[..2]).map(|r| r.version), Some("0.1.0-beta.3".into()));
        // Drafts never count; nothing newer than the newest.
        assert_eq!(pick_newer("0.1.0-beta.3", &list[..3]), None);
        assert_eq!(pick_newer("0.1.0", &list), None);
        // A stable build ignores betas.
        assert_eq!(pick_newer("0.0.9", &[rel("v0.1.0-beta.9", true, false)]), None);
    }
}
