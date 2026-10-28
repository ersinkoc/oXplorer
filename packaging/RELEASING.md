# Releasing OXplorer

One-time setup (repository secrets, Settings → Secrets and variables → Actions):

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the "Developer ID Application" `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: ECOSTACK TECHNOLOGY OU (TEAMID)` |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` | App Store Connect API key, for notarization |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | update-signing key (below) |

Update-signing key (keep the private key out of the repository):

```bash
pnpm tauri signer generate -w ~/.tauri/oxplorer-updater.key
```

Put the content of `~/.tauri/oxplorer-updater.key.pub` into `src-tauri/tauri.conf.json` →
`plugins.updater.pubkey`. Until that's set, builds don't check for updates.

Each release:

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`; add a section to `CHANGELOG.md` (What's New shows it).
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`. The Release workflow builds a signed, notarized universal DMG (plus the update archive and `latest.json` when the updater key is set) into a draft release.
3. Check the draft, publish it.
4. Update `packaging/homebrew/oxplorer.rb` (`version`, `sha256`) in the tap.
