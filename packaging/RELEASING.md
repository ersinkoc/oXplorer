# Releasing OXplorer

One-time setup (repository secrets, Settings → Secrets and variables → Actions):

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the "Developer ID Application" `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password of that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: OXOGNET OÜ (TEAMID)` |
| `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8` | App Store Connect API key, for notarization |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | update-signing key (below) |

Before there's a Developer ID, betas are signed with a self-signed certificate (no Gatekeeper
pass, but a stable signature, so Full Disk Access survives updates; an ad-hoc build's grant
belongs to that one build). Made once, kept outside the repository:

```bash
D=~/.config/oxplorer-signing; mkdir -p $D && cd $D
printf '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n[dn]\nCN=OXplorer Beta Signing\nO=OXOGNET OU\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n' > cert.cnf
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 3650 -config cert.cnf
openssl rand -hex 16 | tr -d '\n' > p12-password.txt
openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -name "OXplorer Beta Signing" -out signing.p12 -passout file:p12-password.txt
base64 -i signing.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD < p12-password.txt
printf 'OXplorer Beta Signing' | gh secret set APPLE_SIGNING_IDENTITY
```

Losing it means a new certificate, and users grant Full Disk Access once more. The Release
workflow's "Check signature" step fails a certificate build whose signature isn't tied to it.

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

## Finder extension

`scripts/build-finder-extension.sh` (run by `build.beforeBundleCommand`) builds
`extensions/finder-sync` with `swiftc` and the bundle embeds it as
`Contents/PlugIns/OXplorerFinder.appex`. It's signed with `APPLE_SIGNING_IDENTITY` when that
certificate is in the keychain (the Release workflow imports it first), otherwise ad hoc.
Check a release with:

```bash
codesign -dv OXplorer.app/Contents/PlugIns/OXplorerFinder.appex   # Authority=Developer ID Application: …
```

Users turn it on in System Settings → General → Login Items & Extensions → Finder (after
opening OXplorer once from /Applications).

