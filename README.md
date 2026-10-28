# OXplorer

A modern, open-source, dual-pane file manager for macOS — Finder's look and feel with Total Commander's efficiency. Built with Tauri 2, React 19 and Rust.

> Status: early development. Phases 0–8 of the [plan](oxplorer-project-plan-v2.md) are done and Phase 9 (v1.0 polish) is under way: Turkish and English UI, What's New, problem reports, notifications and the updater are in; signed releases are pending (see [packaging/RELEASING.md](packaging/RELEASING.md)). Not yet signed or released; build it from source.

## Features (so far)

- **Fast listing:** huge folders stream in: 100k entries list in about a second, first rows in ~20 ms. Live updates via FSEvents (~100 ms).
- **Tabs and dual pane:** tabs per pane (pin, drag to reorder or to the other pane), dual pane (⌘U), F5/F6 copy/move to the other pane, and session restore (tabs, layout, scroll positions).
- **File operations:** copy, move, duplicate, trash and delete with progress and cancel, APFS clones, conflict dialog, undo/redo (⌘Z / ⇧⌘Z; trash undo puts items back).
- **Finder interop:** shared clipboard with Finder (⌘C / ⌘V, ⌥⌘V to move), drag and drop to and from Finder, "Open With", native context menus, Finder tags.
- **Preview:** preview pane (⇧⌘P) for images, video, audio, documents, syntax-highlighted code and rendered Markdown, and the native Quick Look panel (Space / ⌘Y).
- **Integrated terminal:** your login shell in a bottom panel (⌃`), with tabs, a Link mode where the pane follows the shell's `cd`, "Go to Folder in Terminal", and drag-and-drop of files as quoted paths.
- **Search:** ⌘F filters a folder; ⇧⌘F searches names, file contents (ripgrep's engine, `.gitignore`-aware) or Spotlight, with results in a tab that works like a folder; Finder tags in the sidebar; ⌘K command palette with frequently used folders.
- **Archives, tags, renaming:** compress to zip / tar.gz / tar.zst and extract (with progress, cancel and undo), add and remove Finder tags, rename many items at once with a live preview.
- **Settings:** a separate Settings window (⌘,) for appearance, tabs, terminal and fully customizable menu shortcuts.
- **Compare panes:** mark what's missing or newer on each side, select the differences and copy them across.
- **Servers:** SFTP, FTP(S), WebDAV and S3 connections in the sidebar; browse, upload, download, rename and delete. Passwords stay in your Keychain.
- **Archives as folders:** double-click a zip or tarball to browse it; open, preview or copy items out without extracting everything.
- **Disk usage:** a treemap of what takes space under a folder (⌥⌘D), zoomable.
- **Git:** status badges for changed, new and ignored files, and the current branch in the status bar.
- **Finder integration:** an "Open in OXplorer" item in Finder's context menu and toolbar (enable it in System Settings → General → Login Items & Extensions → Finder).
- **Native feel:** native icons and thumbnails, macOS menu bar, sidebar vibrancy, dark mode, system accent color.
- **Views:** list, icon and column views (⌘1 / ⌘2 / ⌘3), keyboard-first with Finder shortcuts, type-ahead and natural sorting.
- **Sidebar and status bar:** favorites, mounted volumes with eject, free space, Full Disk Access detection.

## Install

There's no signed release yet. Build from source (below); once releases are published, they'll be on the [Releases page](https://github.com/ersinkoc/oXplorer/releases) and via Homebrew (`packaging/homebrew/oxplorer.rb`), and the app will update itself.

## Development

Requirements: macOS 14+, Xcode Command Line Tools, Rust (stable), Node 24, pnpm.

```bash
pnpm install
pnpm tauri dev                     # restores your last session (home folder on first run)
pnpm tauri dev -- -- ~/Projects    # opens a specific folder in a new tab
pnpm check && pnpm check:rust      # lint, type-check, tests
```

Architecture, decisions and the roadmap live in [oxplorer-project-plan-v2.md](oxplorer-project-plan-v2.md). Contributor and agent rules are in [CLAUDE.md](CLAUDE.md). The original v1 plan is kept for reference in [oxplorer-project-plan.md](oxplorer-project-plan.md).

## License

MIT © ECOSTACK TECHNOLOGY OÜ
