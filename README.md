# OXplorer

A modern, open-source, dual-pane file manager for macOS — Finder's look and feel with Total Commander's efficiency. Built with Tauri 2, React 19 and Rust.

> Status: early development. Phases 0–4 of the [plan](oxplorer-project-plan-v2.md) are done, plus the preview pane and Quick Look from Phase 5. Not yet signed or released; build it from source.

## Features (so far)

- **Fast listing:** huge folders stream in: 100k entries list in about a second, first rows in ~20 ms. Live updates via FSEvents (~100 ms).
- **Tabs and dual pane:** tabs per pane (pin, drag to reorder or to the other pane), dual pane (⌘U), F5/F6 copy/move to the other pane, and session restore (tabs, layout, scroll positions).
- **File operations:** copy, move, duplicate, trash and delete with progress and cancel, APFS clones, conflict dialog, undo/redo (⌘Z / ⇧⌘Z; trash undo puts items back).
- **Finder interop:** shared clipboard with Finder (⌘C / ⌘V, ⌥⌘V to move), drag and drop to and from Finder, "Open With", native context menus, Finder tags.
- **Preview:** preview pane (⇧⌘P) for images, video, audio, text and documents, and the native Quick Look panel (Space / ⌘Y).
- **Native feel:** native icons and thumbnails, macOS menu bar, sidebar vibrancy, dark mode, system accent color.
- **Keyboard-first:** Finder shortcuts, type-ahead, list and icon views, natural sorting.
- **Sidebar and status bar:** favorites, mounted volumes with eject, free space, Full Disk Access detection.

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
