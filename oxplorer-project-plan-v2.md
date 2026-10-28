# OXplorer v2 — macOS File Manager

## Revised Project Plan & Claude Code Development Guide

> **Project Name:** OXplorer (Open eXplorer)
> **Type:** macOS desktop application — dual-pane, tabbed file manager with an integrated terminal
> **License:** MIT
> **Developer:** Ersin / ECOSTACK TECHNOLOGY OÜ
> **Plan revision:** v2 — 2026-10-27 (all versions verified against npm / crates.io on this date)

---

## 0. v1 → v2: What Changed, and Why?

The v1 plan was a solid start, but the versions have aged and some architectural decisions would have caused serious problems down the road.

### 0.1 Version updates (summary)

| Area             | v1     | v2                                    | Note                                                       |
| ---------------- | ------ | ------------------------------------- | ---------------------------------------------------------- |
| Tauri            | 2.x    | **2.12**                              | Channel API, URI scheme, window effects are mature         |
| TypeScript       | 5.x    | **7.0**                               | Go-based native compiler, ~10x faster type-check           |
| Vite             | 6.x    | **8.3**                               | Rolldown-based bundler                                     |
| Vitest           | 3.x    | **5.0**                               |                                                            |
| xterm.js         | 5.x    | **6.0**                               |                                                            |
| tauri-plugin-pty | 0.1    | **0.3.1**                             | (or `portable-pty` directly — see §6.6)                    |
| Framer Motion    | 11     | **motion 14.7**                       | The package is now named `motion`                          |
| notify           | 7      | **8.2** + `notify-debouncer-full 0.7` |                                                            |
| zip              | 2      | **9.1**                               |                                                            |
| chrono           | 0.4    | **removed**                           | Timestamps are sent as epoch ms, the frontend formats them |
| Node             | 22     | **24 LTS** (Krypton)                  |                                                            |
| pnpm             | —      | **12.x**                              |                                                            |
| Rust             | stable | **1.99** stable                       | edition 2024                                               |
| macOS minimum    | 10.15  | **14.0**                              | Modern WebKit (`:has`, container queries, Popover API)     |

### 0.2 Architectural fixes (the part that really matters)

| #   | Problem in v1                                                                                                                                         | v2 solution                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The `fs` plugin was granted `/**` access + `shell:allow-execute`: a single XSS in the frontend takes over the whole disk and the shell                | **All FS operations live in Rust custom commands.** The frontend gets no `fs` or `shell` plugin permission. The Rust side validates paths itself |
| 2   | `decorations: false` + `titleBarStyle: "Overlay"` together: with decorations off, the traffic light buttons **never appear**                           | `decorations: true`, `titleBarStyle: "Overlay"`, `hiddenTitle: true`, `trafficLightPosition`                                                 |
| 3   | `fs_read_dir` returns a `Vec` in one go: the UI freezes in a 100k-file directory and IPC carries one giant JSON                                        | **Streaming via `tauri::ipc::Channel`**: batches of 500, first batch on screen in < 50 ms                                                    |
| 4   | A single global `file-store`: in dual-pane, both panes share the same state                                                                            | **Pane-scoped state**: a `panes[paneId].tabs[tabId]` structure. Dual-pane is in the data model from Phase 1 onward                           |
| 5   | Lucide for file icons: does not look "like Finder"                                                                                                     | **Native icons + QuickLook thumbnails**, via the `oxthumb://` custom URI scheme (no base64 IPC)                                              |
| 6   | Keyboard shortcuts conflict: `Cmd+1` is both tab and list view; `Cmd+D` = delete (Duplicate in Finder); `Cmd+P` and `Cmd+Shift+P` do the same thing   | Finder-compatible, conflict-free table (§8)                                                                                                  |
| 7   | Right-click menu in HTML with Radix: looks foreign on macOS                                                                                            | **Native context menu** (Tauri `Menu.popup()`) + native menu bar                                                                             |
| 8   | TanStack Router: unnecessary in a single-window file manager                                                                                           | Removed. Settings is a separate native window                                                                                                |
| 9   | Playwright + WebDriver for E2E: **`tauri-driver` does not work on macOS** (no WKWebView driver)                                                       | Playwright + mock IPC with `@tauri-apps/api/mocks`; `tempfile`-based integration tests on the Rust side                                       |
| 10  | Copy progress, cancellation and undo exist only in the checklist; no infrastructure                                                                    | **Rust Job Queue**: cancellable jobs, progress via Channel, undo journal                                                                     |
| 11  | TS types and Rust structs are kept in sync by hand                                                                                                     | Automatically generated `bindings.ts` with **tauri-specta**                                                                                  |
| 12  | No Info.plist / TCC permission strings: the app silently fails when accessing Desktop, Documents and Downloads                                         | Usage descriptions + Full Disk Access detection and guidance screen                                                                          |
| 13  | Notarization and signing left until the very end                                                                                                       | Signed and notarized build in CI from Phase 0. No surprises later                                                                            |
| 14  | Sample Rust code uses blocking `std::fs` inside `async fn`, symlinked directories are flagged incorrectly, `calculate_dir_size` loops forever on a symlink cycle | `spawn_blocking` / separate thread pool, `symlink_metadata` + target resolution, inode dedupe (§7)                                  |

---

## 1. Why Still Tauri?

The decision has not changed; the rationale has gotten stronger:

| Criterion                   | Tauri 2.12                                   | Electron    | SwiftUI/AppKit |
| --------------------------- | -------------------------------------------- | ----------- | -------------- |
| Binary                      | ~5–10 MB                                     | ~150 MB+    | ~5 MB          |
| Idle RAM                    | ~40–70 MB                                    | ~200–400 MB | ~20–40 MB      |
| Learning curve for TS devs  | Medium                                       | Low         | High           |
| macOS native API            | Directly from Rust via the `objc2-*` crates  | Node addon  | Direct         |
| FS performance              | Rust                                         | Node        | Swift          |
| Cross-platform              | Linux/Windows possible                       | Yes         | No             |

**What's different in v2:** The `objc2` ecosystem (`objc2-app-kit`, `objc2-quick-look-thumbnailing`, `objc2-quick-look-ui`) is now mature. Native icons, QuickLook and thumbnails can be called from Rust without writing any Swift. This largely closes Tauri's "doesn't feel native" weakness.

---

## 2. Tech Stack — Exact Versions (2026-10-27)

### 2.1 Frontend

| Category           | Package                                                             | Version | Note                                                                                       |
| ------------------ | ------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| Tauri API          | `@tauri-apps/api`                                                   | 2.12.x  |                                                                                            |
| Tauri CLI          | `@tauri-apps/cli`                                                   | 2.12.x  | devDependency, not global                                                                  |
| UI                 | `react`, `react-dom`                                                | 19.3.x  |                                                                                            |
| React Compiler     | `babel-plugin-react-compiler`                                       | 1.0.x   | Manual `useMemo`/`useCallback` unnecessary                                                 |
| Language           | `typescript`                                                        | 7.0.x   | Native compiler                                                                            |
| Build              | `vite`                                                              | 8.3.x   |                                                                                            |
| Vite React         | `@vitejs/plugin-react`                                              | 6.1.x   |                                                                                            |
| CSS                | `tailwindcss`, `@tailwindcss/vite`                                  | 4.3.x   | No `tailwind.config.ts`, CSS-first config                                                  |
| Components         | `shadcn` CLI                                                        | 4.x     | Base UI (`@base-ui/react` 1.9) or Radix (`radix-ui` 1.8) can be chosen. Recommended: **Base UI** |
| Icons (UI)         | `lucide-react`                                                      | 1.x     | Only toolbar and UI icons; file icons are native                                           |
| State              | `zustand`                                                           | 5.0.x   | + `immer` 11.x middleware                                                                  |
| Virtual list       | `@tanstack/react-virtual`                                           | 3.14.x  |                                                                                            |
| Panel resize       | `react-resizable-panels`                                            | 4.x     | shadcn `resizable` is built on top of it                                                   |
| Terminal           | `@xterm/xterm`                                                      | 6.0.x   |                                                                                            |
| Terminal addon     | `@xterm/addon-fit` 0.11, `@xterm/addon-webgl` 0.19                  |         | WebGL renderer                                                                             |
| PTY (JS)           | `tauri-pty`                                                         | 0.3.x   | If the plugin route is chosen                                                              |
| DnD (in-app)       | `@dnd-kit/react`                                                    | 0.5.x   | Pre-1.0, **exact pin**. Fallback: `@dnd-kit/core` 6.3                                      |
| Shortcuts          | `tinykeys`                                                          | 4.x     | With a central command registry                                                            |
| Command palette    | `cmdk`                                                              | 1.1.x   |                                                                                            |
| Toast              | `sonner`                                                            | 2.x     |                                                                                            |
| Syntax highlight   | `shiki`                                                             | 4.x     | Inside a Web Worker, lazy                                                                  |
| Markdown           | `react-markdown`                                                    | 10.x    |                                                                                            |
| PDF                | `pdfjs-dist`                                                        | 6.x     | Or native QuickLook (§6.5)                                                                 |
| Fuzzy filter       | `fuse.js`                                                           | 7.x     | Command palette only; the directory filter is plain substring                              |
| Date               | `date-fns`                                                          | 4.x     | Or just `Intl.DateTimeFormat`                                                              |
| Size               | `pretty-bytes`                                                      | 7.x     | Base-10 to match Finder                                                                    |
| Animation          | `motion`                                                            | 14.x    | Sparing and restrained                                                                     |
| Font               | `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` | 5.3.x   | Alternative for UI: `-apple-system` (SF Pro)                                               |
| Lint + format      | `@biomejs/biome`                                                    | 2.6.x   | A single tool replacing ESLint and Prettier                                                |
| Test               | `vitest` 5.0, `@testing-library/react` 16.3, `happy-dom` 21         |         |                                                                                            |
| E2E                | `@playwright/test`                                                  | 1.64.x  | With mock IPC                                                                              |

### 2.2 Official Tauri plugins

| Plugin                           | Rust / JS | Version | Usage                                                                 |
| -------------------------------- | --------- | ------- | --------------------------------------------------------------------- |
| `tauri-plugin-dialog`            | ✅ / ✅   | 2.8.x   | Confirm, open and save dialogs                                        |
| `tauri-plugin-opener`            | ✅ / ✅   | 2.7.x   | Open in default app, "Show in Finder"                                 |
| `tauri-plugin-os`                | ✅ / ✅   | 2.4.x   |                                                                       |
| `tauri-plugin-clipboard-manager` | ✅ / ✅   | 2.5.x   | Text clipboard (for the file clipboard see §6.8)                      |
| `tauri-plugin-store`             | ✅ / ✅   | 2.5.x   | Settings                                                              |
| `tauri-plugin-window-state`      | ✅ / ✅   | 2.5.x   |                                                                       |
| `tauri-plugin-log`               | ✅ / ✅   | 2.10.x  | Collects Rust and JS logs into a single file                          |
| `tauri-plugin-single-instance`   | ✅        | 2.5.x   | On a second launch, a new tab in the existing window                  |
| `tauri-plugin-updater`           | ✅ / ✅   | 2.14.x  | Signed automatic updates                                              |
| `tauri-plugin-process`           | ✅ / ✅   | 2.4.x   | Relaunch after update                                                 |
| `tauri-plugin-notification`      | ✅ / ✅   | 2.7.x   | Notification when a long-running operation finishes                   |
| `tauri-plugin-drag` (CrabNebula) | ✅ / ✅   | 2.1.x   | Native dragging of files **out of the app** (Finder, Mail, etc.)      |

**Removed:**
- `tauri-plugin-fs`: The frontend has no need to access the disk directly; everything goes through custom commands.
- `tauri-plugin-shell`: Commands run in Rust via `std::process::Command`; the frontend is given no shell permission.
- `tauri-plugin-global-shortcut`: Unnecessary for in-app shortcuts. Will be added if a "summon OXplorer from anywhere" feature comes later.

### 2.3 Rust crates

```toml
[package]
name = "oxplorer"
edition = "2024"
rust-version = "1.95"

[dependencies]
tauri = { version = "2.12", features = ["macos-private-api"] }
tauri-plugin-dialog = "2.8"
tauri-plugin-opener = "2.7"
tauri-plugin-os = "2.4"
tauri-plugin-clipboard-manager = "2.5"
tauri-plugin-store = "2.5"
tauri-plugin-window-state = "2.5"
tauri-plugin-log = "2.10"
tauri-plugin-single-instance = "2.5"
tauri-plugin-updater = "2.14"
tauri-plugin-process = "2.4"
tauri-plugin-notification = "2.7"
tauri-plugin-drag = "2.1"

# IPC type generation (still RC for Tauri 2: exact pin)
specta = { version = "=2.0.0-rc.27", features = ["derive"] }
tauri-specta = { version = "=2.0.0-rc.26", features = ["derive", "typescript"] }
specta-typescript = "*"          # match the version the tauri-specta RC requires

serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
tokio = { version = "1.54", features = ["rt-multi-thread", "macros", "fs", "process", "sync", "time"] }
tokio-util = "0.7"               # CancellationToken
rayon = "1.12"

# File system
notify = "8.2"
notify-debouncer-full = "0.7"
trash = "5.2"
jwalk = "0.9"                    # Parallel recursive walk (size calculation, search)
ignore = "0.4"                   # .gitignore-aware walk
globset = "0.4"
grep-searcher = "0.1"            # ripgrep engine: content search
grep-regex = "0.1"
xattr = "1.6"
plist = "1.10"                   # Finder tags (binary plist xattr)
uzers = "0.12"                   # uid/gid → user and group name
mime_guess = "2"
infer = "0.22"                   # Type detection via magic bytes
unicode-normalization = "0.1"    # NFC/NFD comparison
dirs = "7"

# Archives
zip = "9.1"
tar = "0.4"
flate2 = "1.1"
zstd = "0.14"

# Terminal (option B, see §6.6)
portable-pty = "0.9"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-foundation = "0.3"
objc2-app-kit = { version = "0.3", features = ["NSWorkspace", "NSImage", "NSPasteboard"] }
objc2-quick-look-thumbnailing = "0.3"
objc2-quick-look-ui = "0.3"
objc2-uniform-type-identifiers = "0.3"
block2 = "0.6"

[dev-dependencies]
tempfile = "3.27"

[profile.release]
lto = "fat"
codegen-units = 1
strip = true
panic = "abort"
opt-level = 3
```

> The feature lists of the `objc2-*` crates are long. When you get a compile error, add the missing feature. Each one is enabled individually.

---

## 3. Architecture

### 3.1 Principles

1. **Rust is the single source of truth.** Directory contents, the watcher, the operation queue and the terminal live in Rust. The frontend is only a view of them.
2. **Heavy work is never done on the UI thread or on a tokio worker.** Blocking FS calls run via `spawn_blocking` or `rayon`.
3. **Large data is always streamed.** Listings, search results and progress information flow through `Channel<T>`.
4. **Binary data never goes into JSON.** Thumbnails and icons are loaded as `<img src>` via the `oxthumb://` URI scheme.
5. **A single command registry.** The menu bar, context menu, shortcuts and command palette are all fed from the same `commands` table.
6. **Types are generated, not handwritten.** Rust structs → `src/bindings.ts` (tauri-specta).

### 3.2 Layers

```
┌────────────────────────────────────────────────────────────────────┐
│ PRESENTATION — React 19 + Tailwind 4 + shadcn (Base UI)            │
│  TitleBar · Toolbar · Sidebar · PaneGroup[Pane[TabBar, FileView]]  │
│  PreviewPanel · TerminalPanel · StatusBar · CommandPalette          │
├────────────────────────────────────────────────────────────────────┤
│ COMMAND REGISTRY — id → {title, shortcut, when, run}               │
│  ↔ native menu bar · native context menu · tinykeys · cmdk         │
├────────────────────────────────────────────────────────────────────┤
│ STATE — Zustand 5 + Immer                                          │
│  workspaceStore (panes → tabs → history, selection, viewState)     │
│  dirCacheStore (path → entries, updated by Rust events)            │
│  jobsStore · settingsStore · terminalStore · previewStore          │
├────────────────────────────────────────────────────────────────────┤
│ IPC — src/bindings.ts (tauri-specta, auto-generated)               │
│  commands.*()  ·  Channel<T> streams  ·  events.*                  │
│  oxthumb://<size>/<path>  (custom async URI scheme)                │
├────────────────────────────────────────────────────────────────────┤
│ RUST CORE                                                          │
│  dir::lister   (jwalk/read_dir → batch stream)                     │
│  dir::watcher  (notify 8 FSEvents + debouncer → DirDelta event)    │
│  jobs::queue   (copy/move/trash/delete/compress; cancel; progress) │
│  jobs::undo    (journal)                                           │
│  search        (name: jwalk+globset · content: grep-searcher ·     │
│                 spotlight: mdfind stream)                          │
│  mac::icons / mac::thumbs / mac::quicklook / mac::tags / mac::pb   │
│  volumes       (statfs + /Volumes watcher)                         │
│  pty           (portable-pty sessions, OSC 7 cwd tracking)         │
│  security      (path canonicalize, permission check)               │
└────────────────────────────────────────────────────────────────────┘
```

### 3.3 Directory listing flow (streaming)

```
Frontend                               Rust
────────                               ────
openDir(paneId, path, channel) ──────► spawn_blocking:
                                         read_dir → batches of 500
  ◄────── DirEvent::Batch(entries) ────  (first batch is sent immediately)
  ◄────── DirEvent::Batch(entries) ────
  ◄────── DirEvent::Done{total} ───────  watcher.subscribe(path)
  ...
  ◄────── event "dir-delta" {path, added, removed, changed} (debounce 100ms)
closeDir(path) ──────────────────────► watcher.unsubscribe (ref-count)
```

- If the same directory is open in both panes, the watcher stays single via **ref-counting**.
- `dirCacheStore` holds `path → Map<name, FileEntry>`. Each pane applies its own sort and filter.
- Sorting is done in the frontend with `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`. This gives the same result as Finder's natural sort order. 100k entries < 100 ms.

### 3.4 Operation queue (Job Queue)

```rust
enum JobKind { Copy, Move, Trash, Delete, Compress, Extract, Duplicate }
struct Job { id: JobId, kind: JobKind, sources: Vec<PathBuf>, dest: Option<PathBuf>,
             cancel: CancellationToken, conflict_policy: ConflictPolicy }
enum JobEvent { Planned{total_bytes, total_files}, Progress{done_bytes, done_files, current},
                Conflict{conflict_id, src, dst}, Error{path, error}, Done, Cancelled }
```

- **Planning phase:** First the total size and file count are computed (jwalk), then copying starts. An ETA can be calculated.
- **Copying:** On macOS, `std::fs::copy` first tries **clonefile** on APFS, so copies within the same volume finish instantly. Cross-volume copies use 1 MB chunks and progress reporting.
- **Moving:** `rename` on the same volume. Across volumes: copy + verify + delete.
- **Conflicts:** The job sends a `Conflict` event and waits for the frontend's dialog answer (`oneshot` channel). Options: overwrite / skip / keep both / apply to all.
- **Undo journal:** Every completed job records its inverse operation (`Move b→a` for `Move a→b`, "Put Back" for `Trash`, "move the copies to the Trash" for `Copy`). Permanent deletion cannot be undone, and a warning is shown accordingly.

### 3.5 Window layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ● ● ●   ← → ↑   [ Users › ersin › Projects ▾ ]     ⊞ ☰ ▥  🔍 Filter   │ ← title bar = toolbar (Overlay)
├────────────┬──────────────────────────────┬──────────────────────────┤
│ FAVORITES  │ [Projects] [src] [+]         │ [Downloads] [+]          │ ← each pane has its own tabs
│ ⌂ Home     │ Name ▲        Size   Modif.  │ Name ▲        Size       │
│ 🖥 Desktop  │ 📁 node_modules   —   Today   │ 📄 report.pdf  2.1 MB    │
│ 📄 Documents│ 📁 src            —  Yesterday│ 🖼 photo.heic  3.4 MB    │
│ ⬇ Downloads│ 📄 package.json 1 KB 10:30    │                          │
│ LOCATIONS  │                              │                          │
│ 💽 Macintosh│                              │                          │
│ 💾 USB      │                              │                          │
│ TAGS       │                              │                          │
│ 🔴 Red      │ 12 items, 2 selected · 1.2 MB│ 2 items · 412 GB free    │
├────────────┴──────────────────────────────┴──────────────────────────┤
│ ▸ Preview (vertical panel on the right, or QuickLook with Space)     │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ Terminal  [zsh — Projects] [+]                     ⌃` to toggle    │
└──────────────────────────────────────────────────────────────────────┘
```

- Sidebar background: **real vibrancy** via `windowEffects: ["sidebar"]`, not a CSS imitation.
- The active pane is highlighted with a thin accent border. The `Tab` key switches between panes.

---

## 4. File Structure

```
oxplorer/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── Info.plist                     # TCC usage descriptions
│   ├── Entitlements.plist
│   ├── capabilities/
│   │   ├── main.json                  # Main window: minimal permissions
│   │   └── settings.json              # Settings window
│   ├── icons/
│   └── src/
│       ├── main.rs
│       ├── lib.rs                     # builder, plugins, specta export
│       ├── error.rs                   # AppError (thiserror + Serialize + specta::Type)
│       ├── state.rs                   # AppState: watcher, jobs, pty, settings
│       ├── security.rs                # path validation
│       ├── model.rs                   # FileEntry, VolumeInfo, ...
│       ├── dir/      { mod.rs, lister.rs, watcher.rs, size.rs }
│       ├── jobs/     { mod.rs, queue.rs, copy.rs, trash.rs, archive.rs, undo.rs, conflict.rs }
│       ├── search/   { mod.rs, name.rs, content.rs, spotlight.rs }
│       ├── pty/      { mod.rs, session.rs }
│       ├── volumes.rs
│       ├── menu.rs                    # Native menu bar + context menu builder
│       ├── uri_scheme.rs              # oxthumb:// handler
│       └── mac/      { mod.rs, icons.rs, thumbs.rs, quicklook.rs, tags.rs, pasteboard.rs, tcc.rs }
│
├── src/
│   ├── main.tsx
│   ├── app.tsx
│   ├── bindings.ts                    # ⚠️ AUTO-GENERATED — do not edit by hand
│   ├── commands/                      # Command registry
│   │   ├── registry.ts
│   │   ├── file-commands.ts
│   │   ├── nav-commands.ts
│   │   ├── view-commands.ts
│   │   └── keymap.ts                  # Default shortcuts + user overrides
│   ├── features/                      # Feature-based (feature-sliced)
│   │   ├── workspace/                 # pane-group, pane, tab-bar
│   │   ├── file-view/                 # list-view, grid-view, column-view, rename-input, file-icon
│   │   ├── navigation/                # path-bar, history
│   │   ├── sidebar/
│   │   ├── preview/                   # text, image, media, pdf, markdown, info
│   │   ├── terminal/
│   │   ├── search/
│   │   ├── jobs/                      # progress popover, conflict dialog
│   │   ├── palette/
│   │   └── settings/                  # separate window entry
│   ├── stores/
│   │   ├── workspace-store.ts
│   │   ├── dir-cache-store.ts
│   │   ├── jobs-store.ts
│   │   ├── settings-store.ts
│   │   └── terminal-store.ts
│   ├── lib/                           # path, format, collator, mime→icon fallback
│   ├── workers/                       # shiki highlight worker
│   ├── components/ui/                 # shadcn
│   └── styles/globals.css             # Tailwind 4 @theme tokens, light/dark
│
├── e2e/                               # Playwright + mockIPC
├── .github/workflows/                 # ci.yml, release.yml
├── biome.json
├── package.json
├── tsconfig.json
├── vite.config.ts
├── CLAUDE.md                          # Project rules for Claude Code (§13)
└── README.md
```

---

## 5. Data Model

### 5.1 Rust (single source, auto-converted to TS)

```rust
#[derive(Serialize, specta::Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,             // File | Dir | Symlink | Package (.app, .bundle) | Other
    pub symlink_target: Option<SymlinkInfo>, // { path, isDir, broken }
    pub size: u64,                   // file: len; directory: 0 (computed async)
    pub allocated: u64,              // st_blocks * 512 ("size on disk")
    pub modified_ms: i64,            // epoch ms (date formatting happens in the frontend)
    pub created_ms: Option<i64>,
    pub accessed_ms: Option<i64>,
    pub mode: u32,                   // raw unix mode; "rwxr-xr-x" is produced in the frontend
    pub uid: u32,
    pub gid: u32,
    pub inode: u64,
    pub is_hidden: bool,             // '.' prefix OR UF_HIDDEN flag
    pub extension: Option<String>,
    pub uti: Option<String>,         // "public.jpeg" (lazy, for icon/preview)
    pub tags: Vec<FinderTag>,        // { name, color: 0..7 }
}

#[derive(Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DirEvent { Batch { entries: Vec<FileEntry> }, Done { total: u32 }, Error { error: AppError } }

#[derive(Debug, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppError {
    #[error("not found: {path}")]             NotFound { path: String },
    #[error("permission denied: {path}")]     PermissionDenied { path: String, needs_full_disk_access: bool },
    #[error("already exists: {path}")]        AlreadyExists { path: String },
    #[error("cancelled")]                     Cancelled,
    #[error("{message}")]                     Io { path: Option<String>, message: String },
}
```

### 5.2 Frontend state (summary)

```ts
type PaneId = "left" | "right";

interface WorkspaceState {
  panes: Record<PaneId, PaneState>;
  activePane: PaneId;
  dualPane: boolean;
}
interface PaneState {
  tabs: TabState[];
  activeTabId: string;
}
interface TabState {
  id: string;
  path: string;
  history: { stack: string[]; index: number };
  view: { mode: "list" | "grid" | "columns"; sort: SortConfig; showHidden: boolean; filter: string };
  selection: { paths: Set<string>; anchor: string | null; focus: string | null };
  scrollOffset: number;
  pinned: boolean;
}
```

- Selection is kept **per tab**. That way the selection and scroll position are preserved when switching tabs.
- The workspace (open tabs, pane sizes) is persisted across sessions with `tauri-plugin-store`.

---

## 6. macOS-Specific Implementation Details

### 6.1 Window and title bar

```json
{
  "label": "main",
  "title": "OXplorer",
  "width": 1280,
  "height": 800,
  "minWidth": 820,
  "minHeight": 520,
  "decorations": true,
  "titleBarStyle": "Overlay",
  "hiddenTitle": true,
  "trafficLightPosition": { "x": 16, "y": 20 },
  "transparent": true,
  "windowEffects": { "effects": ["sidebar"], "state": "followsWindowActiveState" }
}
```

- `app.macOSPrivateApi: true` must be set (for the transparent window). Not a problem, since we won't be on the App Store.
- The title bar region gets `data-tauri-drag-region`. ~78 px of space is left on the left for the traffic lights.
- In full screen the traffic lights are hidden; remove the padding via `onResized` + `isFullscreen()`.

### 6.2 Native menu bar and context menu

- In `menu.rs`: **OXplorer** (About, Settings ⌘,, Quit) · **File** · **Edit** · **View** · **Go** · **Window** · **Help**.
- Menu item ids are the same as the command registry ids. `on_menu_event` → a `menu-command` event goes to the frontend → the registry runs it.
- ⚠️ **Custom** menu items are used for `Cmd+C/V/X/A`, not `PredefinedMenuItem::copy`. The frontend checks focus: if a text input is focused, the text clipboard; if the file list is focused, the file clipboard.
- Right click: the frontend calls `invoke('show_context_menu', { target, paths })`, Rust opens the native menu with `Menu::popup()`. The "Open With ▸" submenu is populated via `NSWorkspace URLsForApplicationsToOpenURL:`.

### 6.3 Native icons and thumbnails

- `NSWorkspace.iconForFile:` → NSImage → PNG (16/32/64/128 @2x). **LRU cache** keyed by extension and UTI. Folders, .app bundles and custom icons are per-file.
- Image, video and PDF thumbnails: `QLThumbnailGenerator` (objc2-quick-look-thumbnailing); the result is written to a disk cache (`~/Library/Caches/com.ecostack.oxplorer/thumbs`, key = path + mtime + size).
- Frontend: `<img src={convertFileSrc(`${size}/${encodeURIComponent(path)}`, 'oxthumb')} loading="lazy">`
- Rust: `register_asynchronous_uri_scheme_protocol("oxthumb", …)`. The work is done on a thread pool, and the response is `image/png`.

### 6.4 Finder tags

- Reading: the `com.apple.metadata:_kMDItemUserTags` xattr (binary plist, `["Red\n6", ...]`) is parsed with the `plist` crate.
- Writing: written to the same xattr. There is no need to touch the `com.apple.FinderInfo` color bits for Finder to show the tag immediately; modern macOS reads only userTags.
- Clicking the "Tags" section in the sidebar opens the result of `mdfind "kMDItemUserTags == 'Red'"`.

### 6.5 Preview

- **Space** key: opens the native `QLPreviewPanel` (objc2-quick-look-ui). The real macOS QuickLook experience; supports video, audio, PDF, Office and iWork files alike.
- **Preview panel** (in-app): text and code (shiki, in a worker; first 256 KB), markdown, images (large `oxthumb` size or the `asset:` protocol), audio and video (`<video>`, asset protocol), and a large thumbnail plus info card for everything else.
- The asset protocol scope is granted dynamically from Rust only for **the file currently being previewed** (`asset_protocol_scope().allow_file()`), not `/**`.

### 6.6 Terminal

There are two options:

|            | A) `tauri-plugin-pty` 0.3 | B) Own PTY module (`portable-pty` 0.9) — **recommended** |
| ---------- | ------------------------- | -------------------------------------------------------- |
| Setup      | Fast                      | ~200 lines of Rust                                       |
| Control    | Limited                   | Full: env, cwd, session shutdown, OSC tracking           |
| Data flow  | Plugin events             | `Channel<Vec<u8>>` (low overhead)                        |
- xterm 6 + WebGL addon + fit addon. The theme is derived from the file manager's theme.
- **Directory sync:** In the Terminal → OXplorer direction, the shell's OSC 7 (`\e]7;file://host/path\a`) output is captured. macOS zsh sends this by default. In "Link" mode the active pane navigates to that directory. In the OXplorer → terminal direction, `cd -- 'path'` is typed if the user asks for it (not automatically, so as not to mess up the prompt).
- The default shell is `$SHELL`, started as a login shell (`-l`). `TERM=xterm-256color`, `COLORTERM=truecolor`.

### 6.7 Trash

- The `trash` crate's default on macOS is the `NSFileManager.trashItemAtURL` method: it is fast and needs no permission, but it does not write Finder's **"Put Back"** information.
- `DeleteMethod::Finder` (AppleScript): "Put Back" works, but it requires the Automation permission and is slow.
- **Decision:** NSFileManager by default. OXplorer undoes via its own undo journal. A "Finder-compatible trash (Put Back)" option is offered in the settings.

### 6.8 File clipboard (two-way with Finder)

- Copy: `NSPasteboard.generalPasteboard` → `writeObjects:[NSURL]`. This way it can be pasted in Finder with ⌘V.
- Paste: if the pasteboard contains `public.file-url`, it is read (files copied in Finder with ⌘C can be pasted into OXplorer).
- "Cut" does not exist at the pasteboard level on macOS. As in Finder, the ⌘C followed by **⌥⌘V (Move Here)** model is used. ⌘X is also supported for Windows habits: in that case a "cut" mark is kept in in-app state.

### 6.9 Permissions (TCC) and Full Disk Access

`Info.plist`:

```xml
<key>NSDesktopFolderUsageDescription</key><string>OXplorer needs access to show your Desktop folder.</string>
<key>NSDocumentsFolderUsageDescription</key><string>OXplorer needs access to show your Documents folder.</string>
<key>NSDownloadsFolderUsageDescription</key><string>OXplorer needs access to show your Downloads folder.</string>
<key>NSRemovableVolumesUsageDescription</key><string>OXplorer needs access to show external drives.</string>
<key>NSNetworkVolumesUsageDescription</key><string>OXplorer needs access to show network drives.</string>
```

- **Full Disk Access detection:** try to read a protected path such as `~/Library/Containers/com.apple.stocks`. If you get `EPERM`, show a banner: "Open System Settings for full access" → `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`.
- `AppError::PermissionDenied { needs_full_disk_access }` is shown in the UI as a meaningful empty-state screen.

### 6.10 Other macOS details

- **Packages:** `.app`, `.bundle`, `.photoslibrary` are shown as **packages**, not folders. Double click = open. "Show Package Contents" is in the context menu.
- **Hidden files:** files with a '.' prefix **and** those with the `UF_HIDDEN` flag (such as `/usr`, `~/Library`).
- **.DS_Store**, `._*` (AppleDouble) and `Icon\r` files are filtered out by default even when "show hidden" is on (configurable).
- **Unicode:** name comparisons are done after normalizing to NFC (HFS+, SMB and exFAT disks may use NFD).
- **Volumes:** the `/Volumes` directory is watched, and the sidebar updates instantly on mount and unmount. For eject, `diskutil eject` or `NSWorkspace.unmountAndEjectDeviceAtPath`.
- **Dark mode:** `prefers-color-scheme` + the Tauri `theme` event. The accent color is read from the system (`NSColor.controlAccentColor`).

---

## 7. Security Model

1. **Capability minimization:** `main.json` contains only `core:default`, `dialog`, `opener`, `store`, `window-state`, `log`, `updater`, `process`, `notification`, `clipboard-manager:allow-write-text` and the custom command permissions. **There is no `fs` or `shell` plugin permission.**
2. **Permissions for custom commands:** each command is added to the ACL in `build.rs` via `tauri_build::Attributes::new().app_manifest(AppManifest::new().commands(&[...]))`. The settings window cannot call FS commands.
3. **Path validation (`security.rs`):** every incoming path must be absolute; `..` segments are rejected. Destructive operations get extra protection: permanent deletion of `/`, `/System`, `/usr` and the `~` root itself is blocked.
4. **CSP:** `default-src 'self'; img-src 'self' oxthumb: asset: data:; media-src asset:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src ipc: http://ipc.localhost`
5. **Preview security:** raw HTML is disabled in Markdown and HTML previews. SVG is rendered as `<img>` (scripts do not run).
6. **Command execution:** only in Rust, with an argument array (`Command::new("mdfind").arg(q)`). No shell string interpolation.
7. **Signing:** Developer ID Application certificate + hardened runtime + notarization. Updater artifacts are additionally signed with the Tauri updater key.

---

## 8. Keyboard Shortcuts (Finder-compatible, conflict-free)

| Shortcut         | Action                                        | Also in Finder?           |
| ---------------- | --------------------------------------------- | ------------------------- |
| `⌘C` / `⌘V`      | Copy / Paste                                  | ✅                        |
| `⌥⌘V`            | Move here (cut-paste)                         | ✅                        |
| `⌘X`             | Cut (Windows habit)                           | —                         |
| `⌘Z` / `⇧⌘Z`     | Undo / Redo                                   | ✅                        |
| `⌘A`             | Select all                                    | ✅                        |
| `⌘D`             | **Duplicate**                                 | ✅                        |
| `⌘⌫`             | Move to Trash                                 | ✅                        |
| `⌥⌘⌫`            | Delete permanently (with confirmation)        | ✅                        |
| `↩`              | Rename                                        | ✅                        |
| `F2`             | Rename (Windows habit)                        | —                         |
| `⌘O` / `⌘↓`      | Open / Enter folder                           | ✅                        |
| `⌘↑`             | Parent directory                              | ✅                        |
| `⌘[` / `⌘]`      | Back / Forward                                | ✅                        |
| `⇧⌘N`            | New folder                                    | ✅                        |
| `⌥⌘N`            | New file                                      | —                         |
| `Space`          | QuickLook                                     | ✅                        |
| `⌘I`             | Info / properties                             | ✅                        |
| `⌘1 / ⌘2 / ⌘3`   | List / Grid / Column view                     | ✅ (Finder's order differs) |
| `⌘T` / `⌘W`      | New tab / Close tab                           | ✅                        |
| `⌃Tab` / `⌃⇧Tab` | Next / previous tab                           | ✅                        |
| `⌥⌘1…9`          | Go to Nth tab                                 | —                         |
| `Tab`            | Switch active pane                            | —                         |
| `⌘U`             | Toggle dual-pane                              | —                         |
| `F5` / `F6`      | Copy / move to the other pane (Total Commander) | —                       |
| `⇧⌘.`            | Show/hide hidden files                        | ✅                        |
| `⌘F`             | Filter in this directory                      | —                         |
| `⇧⌘F`            | Advanced search (name, content, Spotlight)    | ~                         |
| `⇧⌘G`            | Go to folder (enter path)                     | ✅                        |
| `⌘K`             | Command palette                               | —                         |
| ``⌃` ``          | Toggle terminal                               | —                         |
| `⌘R`             | Refresh                                       | —                         |
| `⌘,`             | Settings                                      | ✅                        |
| Typing letters   | Type-ahead: jump to the file starting with that letter | ✅               |

All shortcuts are defined in `commands/keymap.ts` and can be changed in the settings. The accelerators in the native menu are generated from the same keymap.

---

## 9. Development Phases

> Durations assume a single part-time developer + Claude Code. Each phase has a **Definition of Done (DoD)** item. The next phase is not started until the DoD is met.

### Phase 0 — Foundation, CI and signing (1 week)

- [x] `pnpm create tauri-app` (React + TS), Vite 8, TS 7, Tailwind 4, Biome
- [ ] shadcn (Base UI) — in Phase 3 together with the first dialogs
- [x] edition 2024, clippy `-D warnings`, rustfmt
- [ ] clippy pedantic (selected lints)
- [x] tauri-specta setup: `bindings.ts` generation via `cargo test export_bindings` or in debug builds
- [x] `AppError` + `security.rs` skeleton
- [x] GitHub Actions: `ci.yml` (biome, tsc, vitest, cargo clippy/test) + `release.yml` (universal binary, signing, notarize, DMG)
- [ ] Apple Developer ID certificate + App Store Connect API key → GitHub secrets (waiting on the user)
- [x] `CLAUDE.md` (§13)
- **DoD:** An empty window opens, CI is green, and the **signed and notarized DMG** opens on another Mac without a Gatekeeper warning.

### Phase 1 — Shell and listing (2 weeks)

- [x] Window: Overlay title bar, traffic light position, sidebar vibrancy, native menu bar skeleton
- [x] `dir::lister` streaming (`Channel<DirEvent>`), `FileEntry` (except tags and uti)
- [x] `workspace-store` (pane → tab model; a single pane is shown for now), `dir-cache-store`
- [x] Virtualized list view: columns (Name, Modified, Size, Kind), sorting, column widths
- [x] Selection: click, ⌘click, ⇧click, keyboard arrow keys, ⌘A, type-ahead
- [x] Path bar (breadcrumb + edit via ⇧⌘G), back/forward/up
- [x] Sidebar: Favorites (defaults), Locations (volumes)
- [x] Status bar: item count, selection size, free space
- [x] Hidden files toggle, `UF_HIDDEN`, package detection
- [x] TCC error screen + FDA banner
- **DoD:** `~/Library` (with FDA) and a 100k-file test directory (`scripts/gen-fixture.sh`) open without freezing; the first rows appear in < 100 ms.

### Phase 2 — Liveness and native look (1.5 weeks)
- [x] `dir::watcher`: notify 8 + debouncer (NoCache), ref-count, `dir-changed` event, updating while preserving the selection
- [x] Native icons + `oxthumb://` URI scheme + memory and disk cache
- [x] Grid (icon) view, with QuickLook thumbnails (⌘2)
- [x] Finder tags (reading; streamed in a separate phase after listing)
- [ ] Tags in the sidebar: moved to Phase 7, since clicking requires a Spotlight search
- [x] Volumes mount/unmount tracking (`/Volumes` is watched), eject
- [x] Dark/light theme + system accent color
- **DoD:** When `touch`/`rm` is run from the terminal, the list updates in < 300 ms. Icons look the same as in Finder.
- **Measured:** watcher latency ~95 ms; 100k folder in 1.15 s (tags ~1.4 s later); bulk create/delete of 500 files is complete with nothing missed.

### Phase 3 — File operations (2.5 weeks)
- [x] Job queue: copy, move, duplicate, trash, delete; planning, progress, cancellation (`copyfile(3)`: APFS clone + metadata + tags)
- [x] Conflict dialog (Replace / Skip / Keep Both / Stop, apply to all; the replaced item goes to the Trash)
- [x] Operations popover (progress ring in the toolbar); error toasts instead of a completion notification
- [x] Undo/redo journal ("Put Back" using the real Trash location)
- [x] New folder/file, inline rename (comes selected without the extension, Finder behavior)
- [x] Native context menu + "Open With" + "Show in Finder" + "Copy Path" (⌥⌘C)
- [x] Two-way copy/paste with Finder via NSPasteboard (⌘X + ⌘V = move, ⌥⌘V)
- [x] In-app DnD (same volume moves, different volume copies, ⌥ = copy) + drop in from Finder + drag out to Finder (`tauri-plugin-drag`)
- [x] Directory size calculation (inode dedupe, cancellable) + "Info" (⌘I) panel
- [x] macOS notification (when long jobs finish) — done in Phase 9: jobs over 10 s notify when OXplorer isn't in front
- **DoD:** A 10 GB / 50k-file copy can be cancelled, progress is accurate, undo works. Rust integration tests (`tempfile`) cover all operation types.
- **Measured:** 50k files + 1 GB on the same volume in 4.7 s; 0 leftovers at the destination when cancelled midway; the in-app IPC self-test (create → copy → duplicate → trash → undo → rename → measure → delete) passed.

### ⭐ MVP — v0.1.0 (Phase 0–3, ~7 weeks)

A single-pane, real-time, native-looking, secure file manager. Distributed as a signed DMG + Homebrew cask.

### Phase 4 — Tabs and Dual-pane (2 weeks)

- [x] Per-pane tab bar, drag to reorder, pin, context menu (close, close others, close tabs to the right) — ⌘T/⌘W, ⌃Tab/⌃⇧Tab, ⌥⌘1…9; ⇧⌘W closes the window
- [x] Dual-pane (⌘U), resizable, active pane indicator, switching with `Tab` (+ Swap Panes, Open in Other Pane)
- [x] F5/F6 copy/move to the other pane, DnD between panes (files can also be dropped onto tabs)
- [x] Moving a tab to the other pane (drag or menu)
- [x] Session restore (tabs, scroll position, pane sizes) — `session.json`, scroll per tab+folder (also restored on Back)
- [x] `single-instance`: an `open -a OXplorer ~/x` call opens a new tab in the existing window (second launch verified; `open -a`/Dock → `RunEvent::Opened`, CFBundleDocumentTypes for folders)
- **DoD:** When the app is closed and reopened, all tabs and the pane layout come back exactly as they were. ✅ (on reopen, dual-pane, pinned tab, view/sort and split ratio were restored)

### Phase 5 — Preview and QuickLook (1.5 weeks)

- [x] Native `QLPreviewPanel` via Space/⌘Y (updates as the selection changes, navigable with arrow keys) — controller methods are added to the window class at runtime
- [x] Preview panel: code (shiki worker), markdown, image, audio/video, info card — image/video/audio (`asset:` dynamic scope), text (first 256 KB; shiki 4 in a module worker with the JS regex engine, languages loaded lazily, up to 128 KB highlighted, 3 s watchdog), Markdown (react-markdown + GFM, no raw HTML, links open in the browser, Preview/Source toggle), QL thumbnail, info card, multi-selection summary (⇧⌘P)
- [x] Column view (the last column shows a preview) — ⌘3; columns start at the home folder / volume / disk root, → enters a folder, ← goes back
- **DoD:** A 50 MB log file does not freeze the UI in the preview (only the first 256 KB is read). ✅ (`reads_only_the_head_of_large_files` test; highlighting is skipped above 128 KB)

### Phase 6 — Integrated terminal (1.5 weeks)

- [x] PTY module (`portable-pty`), `Channel<Vec<u8>>` stream, resize — output is sent as UTF-8 text (sequences split across reads are joined in Rust) since specta can't type raw byte channels; login shell, `TERM=xterm-256color`, `LANG` defaulted for Finder launches
- [x] xterm 6 + WebGL + fit, terminal tabs — bottom panel (⌃` show/hide, ⌃⇧` new), resizable, shells keep running while hidden; ⌘C/⌘V/⌘A/⌘⌫ go to the focused terminal; ⌘-click opens links
- [x] cwd tracking via OSC 7, "sync with pane" mode — macOS zsh only emits OSC 7 inside Apple Terminal, so zsh starts with a `ZDOTDIR` shim that sources the user's dotfiles and adds a `precmd` hook; reports from other hosts (ssh) are ignored; "Go to Folder in Terminal" types `cd -- <path>`
- [x] Drag a file to the terminal → the escaped path is pasted (from the panes and from Finder)
- **DoD:** TUI apps such as `vim`, `htop` and `claude` work properly, and resizing is smooth. ✅ at the PTY level: `vim` (alternate screen, sees 120x40 after resize, clean exit) and `htop` from the login shell are tested; `claude` and the on-screen rendering are not verified by the agent

### Phase 7 — Search (1.5 weeks)

- [x] ⌘F: Instant filter in the current directory (in search results ⌘F edits the search)
- [x] Sidebar "Tags" section (`mdfind kMDItemUserTags`) — names from Finder's `FavoriteTagNames` preference (the `SyncedPreferences` plist in §6.4 doesn't exist on current macOS)
- [x] ⇧⌘F: Advanced search panel — Name / Contents / Spotlight, match case, regex, hidden files, scope (folder / Home / This Mac), live count, Stop (Esc)
  - Name: `jwalk` + `globset`, recursive, stream — implemented with `ignore`'s parallel walker instead of jwalk (one walker for both modes); NFC-normalized, packages are single items
  - Content: `ignore` + `grep-searcher` (ripgrep engine), `.gitignore`-aware, with line previews
  - Spotlight: `mdfind -0 -onlyin` stream, plus tag and kind filters
- [x] Results open in a regular "virtual directory" tab (all file operations work on the results too) — `search:?q=…&mode=…&in=…` paths, so history, new tabs and session restore work; the last column shows the location or the matching line; results follow renames/deletes; max 10,000 results
- [x] ⌘K Command palette (commands + recently visited directories + favorites, sorted by frecency) — also accepts a typed `/` or `~` path
- **DoD:** A content search in the home directory can be cancelled, and results stream in. ✅ First results after ~100 ms; the engine stops 0.3 ms after cancel in normal folders. In TCC-protected folders (~/Documents) a single open() can take 0.5–2.5 s under parallel load and can't be interrupted, so the UI marks the search stopped immediately and the engine winds down in the background (`bench_content_home`).

### Phase 8 — Archives and settings (1.5 weeks)

- [x] Compress (zip, tar.gz, tar.zst) and extract: via the job queue, with progress — cancellable, undoable, written under a temporary name and renamed into place; extraction follows Archive Utility (one top-level item lands as itself, otherwise a folder); zip-slip and symlink-traversal are refused; setuid bits dropped. Not kept in archives: extended attributes and resource forks
- [x] Settings window (separate native window): general, appearance, shortcuts, terminal, advanced — second Vite page with its own capability (no file-system commands); preferences shared through the store, the main window applies changes live
- [x] Shortcut customization (with conflict detection) — menu bar rebuilt at runtime; Rust validates accelerators (muda) and refuses duplicates; the UI offers to move a taken shortcut. ⌥⌘1…9 and ⌘↓ stay fixed
- [x] Writing tags (add/remove) — context-menu Tags submenu with check marks for Finder's sidebar tags (no undo yet)
- [x] Batch rename (prefix/suffix, find-replace, regex, numbering; with live preview) — Finder's three modes; all-or-nothing in Rust (temporary names, rollback), undoable

### Phase 9 — Polish and v1.0 (2 weeks)

- [ ] Accessibility: ARIA grid/tree roles, VoiceOver testing, full keyboard navigation — ARIA roles and labels are in place (Biome a11y rules enforced, labels translated); ⏳ VoiceOver testing needs a person
- [x] Performance pass: React Profiler, Rust `cargo flamegraph`, large-directory benchmarks (§11) — measured 2026-10-28 on an M-series Mac, release build: 10k listing 16 ms, 100k 160 ms (then 1.6 s of background tag reading), UI ready ~350 ms (~700 ms on the first launch of a fresh build; the page itself is ready ~90–100 ms after it starts loading, the rest is process and WebKit start-up), idle memory 81 MB (app 32 + WebKit 49; the terminal now loads on first use) with one tab, app 11.9 MB, DMG 5.6 MB (arm64)
- [ ] Updater (signed) + "What's New" screen — ✅ What's New (CHANGELOG.md, shown once after an update); ✅ updater wired to GitHub Releases (`latest.json`), "Check for Updates…" plus a quiet daily check, release workflow builds update artifacts when the key secret exists; ⏳ the update-signing key must be generated by the owner (`packaging/RELEASING.md`) — until its public key is in `tauri.conf.json`, builds don't check
- [x] Crash/error logs (`tauri-plugin-log`), "Report a problem" button (GitHub issue template with logs attached) — panics are logged with a backtrace; Help → Report a Problem opens a prefilled issue form (versions only; the log has paths, so the user attaches the relevant part via Help → Show Log File)
- [x] i18n: Turkish + English (simple JSON dictionary) — English text as keys, `src/i18n/tr.ts` (360+ entries), native menu labels sent to Rust, language follows macOS or the setting; a test fails on missing/unused keys or placeholder mismatches
- [ ] Homebrew cask, README, screenshots, website — ✅ cask template (`packaging/homebrew/oxplorer.rb`), release guide (`packaging/RELEASING.md`), README; ⏳ screenshots and a website
- **DoD:** v1.0.0 release.

**Total:** MVP ~7 weeks · v1.0 ~19 weeks

### Phase 10+ (later)

- [x] Git status badges (`gix` 0.90): modified, added and ignored files are marked in the list — gix 0.89 (0.90 was 6 days old): M/A/U/R/D/! badges, ignored items dimmed, folders show the strongest state inside, branch in the status bar; refreshed on file changes, after each terminal command and on window focus; 5 s limit for huge repos (11 ms for this repo)
- Remote file systems: SFTP, S3, WebDAV (`opendal` 0.59) as "connections" in the sidebar
- Browsing archives like folders (entering a zip)
- [x] Directory comparison and synchronization (diff between the two panes) — Window → Compare Panes marks items only in one pane, newer, older or same-date-different-size (2 s slack for FAT); Select Differences + F5 syncs one direction
- Disk usage visualization (treemap / sunburst)
- Finder Sync / Share extension (requires a Swift helper target)

---

## 10. Development Environment

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable                    # 1.99+
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # for the universal build

# Node 24 LTS (fnm/mise/volta)
fnm install 24 && fnm default 24
corepack enable && corepack prepare pnpm@latest --activate   # pnpm 12

# The Tauri CLI is NOT installed globally; it comes as a project devDependency:
pnpm tauri dev
```

Helper tools: `cargo install cargo-nextest cargo-flamegraph cargo-machete` (detecting unused dependencies).

---

## 11. Performance Targets and Measurement

| Metric                            | Target                        | Measurement method                           |
| --------------------------------- | ----------------------------- | -------------------------------------------- |
| Cold start (first paint)          | < 600 ms                      | `performance.now()` + Rust setup timestamp   |
| 10k-file directory: first rows    | < 50 ms                       | Time to the first batch event from the lister |
| 10k-file directory: complete      | < 250 ms                      | `Done` event                                 |
| 100k-file directory: complete     | < 1.5 s, UI at 60 fps         | Fixture script + Performance panel           |
| Scroll (100k rows)                | 60 fps (120 fps on ProMotion) |                                              |
| Watcher latency                   | < 300 ms                      | e2e: `touch` → DOM                           |
| Same-volume copy (APFS)           | Instant (clonefile)           |                                              |
| Cross-volume copy                 | ≥ 90% of disk speed           | Comparison with `dd`                         |
| Idle RAM                          | < 80 MB (including WebKit)    | Activity Monitor "Memory" (measured: 81 MB) |
| DMG size                          | < 15 MB (universal)           |                                              |

`scripts/gen-fixture.sh` generates 10k, 100k and deeply nested directories, unicode and NFD names, symlink cycles and large files.

---

## 12. Test Strategy

| Layer            | Tool                                              | Scope                                                                              |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Rust unit        | `cargo nextest`                                   | path validation, sort and filter helpers, conflict naming ("file 2.txt")           |
| Rust integration | `tempfile` + real FS                              | lister, watcher, job queue (copy/move/trash/cancel/undo), archives, symlink cycles |
| Frontend unit    | Vitest 5 + happy-dom                              | stores (selection logic, history), keymap, formatters                              |
| Component        | Testing Library                                   | file list, path bar, rename input                                                  |
| E2E (UI)         | Playwright + `@tauri-apps/api/mocks` (`mockIPC`)  | User flows, on the Vite dev server                                                 |
| Manual smoke     | Release checklist                                 | On the real .app: TCC, QuickLook, DnD, terminal                                    |

> Note: since `tauri-driver` does not support macOS, automated E2E on the real app is not possible. That is why business logic is kept in Rust as much as possible and covered by integration tests.

---

## 13. CLAUDE.md (to be copied into the project)

```markdown
# OXplorer — Claude Code rules

## Stack

Tauri 2.12 · React 19 (React Compiler on) · TS 7 · Vite 8 · Tailwind 4 · shadcn (Base UI) · Zustand 5 + Immer · Biome 2

## Commands

- Dev: `pnpm tauri dev`
- Check (after every change): `pnpm check` (= biome check + tsc --noEmit + vitest run) and `cargo clippy --all-targets -- -D warnings && cargo nextest run` (inside src-tauri)
- Binding generation: `pnpm bindings` → src/bindings.ts

## Rules

- `src/bindings.ts` is AUTO-generated. Do not edit it by hand. Change the Rust struct, then regenerate.
- The frontend NEVER accesses the disk directly. `@tauri-apps/plugin-fs` and `plugin-shell` are NOT installed.
- New Rust command: `#[tauri::command] #[specta::specta]` + `Result<T, AppError>` + add to the `collect_commands!` list + add to the build.rs ACL.
- Blocking FS calls go inside `tauri::async_runtime::spawn_blocking`.
- Anything that returns a list or progress is streamed via `Channel<T>`. Do not return large `Vec`s.
- All paths are absolute and go through the `security::validate_path` check.
- Timestamps are epoch ms (i64). Formatting is done in the frontend with `Intl`.
- Adding a shortcut, menu or context menu = adding a command to the `src/commands/` registry. No scattered `onKeyDown` handlers.
- State is pane/tab scoped. There is no global "current dir" state.
- TS: strict, `noUncheckedIndexedAccess`, no `any`. File names are kebab-case. `@/` → `src/`.
- Rust: edition 2024, `unwrap()` only in tests, error messages displayable to the user in Turkish/English.
- macOS shortcuts: consistent with Finder (see plan §8). Cmd, not Ctrl.
```

---

## 14. Claude Code Prompt — Phase 0 + Phase 1

```
# OXplorer — Phase 0 + 1

Read the oxplorer-project-plan-v2.md file in this folder from start to finish. The architectural decisions (§0.2, §3, §6, §7) are binding.

## Phase 0
1. Create the project with `pnpm create tauri-app@latest oxplorer --template react-ts --manager pnpm` and move its contents into this folder.
2. Update the versions according to the tables in §2 (Vite 8, TS 7, React 19.3, Tailwind 4.3 + @tailwindcss/vite, Biome 2.6). Enable the React Compiler.
3. `pnpm dlx shadcn@latest init` (Base UI) → button, input, dialog, tooltip, scroll-area, separator, resizable, sonner, command.
4. src-tauri: the Cargo.toml from §2.3 (only what this phase needs: tauri, dialog, opener, os, store, window-state, log, single-instance, specta, tauri-specta, serde, thiserror, tokio, notify, trash, xattr, uzers, objc2*), edition 2024.
5. Set up tauri-specta: export `../src/bindings.ts` in debug builds + a `pnpm bindings` script.
6. Write error.rs (AppError, §5.1) and security.rs (validate_path), together with unit tests.
7. capabilities/main.json according to §7.1: NO fs and shell.
8. Info.plist (§6.9), tauri.conf.json window settings (§6.1), CSP (§7.4).
9. .github/workflows/ci.yml and release.yml (signing and notarization secrets: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH, TAURI_SIGNING_PRIVATE_KEY).
10. Create CLAUDE.md (§13).

## Phase 1
All of the Phase 1 items in §9. In particular:
- `open_dir(path, show_hidden, on_event: Channel<DirEvent>)` → spawn_blocking, batches of 500, symlink_metadata + target resolution, UF_HIDDEN, package detection.
- `list_volumes()`, `home_dir()`, `check_full_disk_access()`.
- Set up workspace-store with the pane → tab model (the UI shows a single pane for now).
- List view: @tanstack/react-virtual, fixed row height of 24 px, sort on column header click, Intl.Collator numeric.
- Selection: click, ⌘, ⇧, arrow keys, ⌘A, type-ahead.
- Native menu bar skeleton (menu.rs) and command registry (src/commands/).

## Verification
- `pnpm check` and `cargo clippy -D warnings && cargo nextest run` are clean.
- The directory created with `scripts/gen-fixture.sh /tmp/ox-100k 100000` opens without freezing.
- `pnpm tauri dev`: traffic lights are visible, the sidebar has vibrancy, the home directory is listed, the status bar is populated.
Check off the corresponding checkbox in the plan when you finish each step.
```

---

## 15. Reference Apps

| App              | Price       | What to learn                                                 |
| ---------------- | ----------- | ------------------------------------------------------------- |
| Finder           | —           | Shortcuts, rename behavior, column view, tags                 |
| ForkLift 4       | Paid        | Dual-pane + remote, job queue UI                              |
| Path Finder      | Paid        | Modular panels, terminal                                      |
| Commander One    | Freemium    | TC shortcuts (F5/F6)                                          |
| QSpace Pro       | Cheap       | Lightweight, quad-pane                                        |
| Marta            | Free        | Keyboard-focused, fast                                        |
| Double Commander | OSS         | TC compatibility                                              |
| Spacedrive       | OSS (Tauri) | File manager architecture with Tauri, pitfalls to watch for   |

**What sets OXplorer apart:** Open source; a Finder feel with native icons, QuickLook and vibrancy; Total Commander efficiency; an integrated terminal and fast content search. All in a package of < 15 MB.

---

## 16. Risks

| Risk                                         | Likelihood | Impact | Mitigation                                                                                                                        |
| -------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| tauri-specta is still RC                     | Medium     | Medium | Exact pin. Fallback plan: `ts-rs` 12 + handwritten invoke wrappers                                                                |
| `@dnd-kit/react` pre-1.0                     | Medium     | Low    | Exact pin. Fallback: `@dnd-kit/core` 6.3                                                                                          |
| unsafe / feature mess in the objc2 APIs      | Medium     | Medium | Keep it isolated in the `mac/` module, write each function small and tested                                                       |
| Scroll jank on large lists in WKWebView      | Low        | High   | Fixed row height, `contain: strict`, `loading=lazy` on icons, prevent unnecessary re-renders with React Compiler + selectors      |
| TCC permission mess                          | High       | Medium | FDA detection and empty-state screens in Phase 1                                                                                  |
| Notarization problems                        | Medium     | High   | Solved in Phase 0, every release comes out of CI                                                                                  |
| Scope creep                                  | High       | High   | The MVP boundary is firm (Phase 0–3). The Phase 10+ list is the "parking lot"                                                     |
