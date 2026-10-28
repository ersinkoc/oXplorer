# Homebrew cask for OXplorer, for a tap such as ersinkoc/homebrew-tap
# (Casks/oxplorer.rb). After each release, set `version` and `sha256`:
#   shasum -a 256 OXplorer_<version>_universal.dmg
cask "oxplorer" do
  version "0.1.0"
  sha256 "REPLACE_WITH_SHA256_OF_THE_RELEASE_DMG"

  url "https://github.com/ersinkoc/oXplorer/releases/download/v#{version}/OXplorer_#{version}_universal.dmg"
  name "OXplorer"
  desc "Dual-pane file manager with tabs, search and an integrated terminal"
  homepage "https://github.com/ersinkoc/oXplorer"

  # The app updates itself (signed updates from GitHub Releases).
  auto_updates true
  depends_on macos: ">= :sonoma"

  app "OXplorer.app"

  zap trash: [
    "~/Library/Application Support/com.ecostack.oxplorer",
    "~/Library/Caches/com.ecostack.oxplorer",
    "~/Library/Logs/com.ecostack.oxplorer",
    "~/Library/WebKit/com.ecostack.oxplorer",
    "~/Library/Saved Application State/com.ecostack.oxplorer.savedState",
  ]
end
