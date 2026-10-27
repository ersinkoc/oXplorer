# OXplorer — macOS File Manager

## Project Plan & Claude Code Development Guide

> **Project Name:** OXplorer (Open eXplorer)
> **Project Type:** macOS Desktop Application — File Manager
> **Goal:** A modern, dual-pane file manager similar to Windows Explorer
> **License:** MIT (Open Source)
> **Developer:** Ersin / ECOSTACK TECHNOLOGY OÜ

---

## 1. Why This Stack?

### Tauri v2 + React + TypeScript

| Criterion                     | Tauri v2           | Electron         | Swift/SwiftUI   |
| ----------------------------- | ------------------ | ---------------- | --------------- |
| Binary size                   | ~3-8MB             | ~150MB+          | ~5MB            |
| RAM usage                     | ~30-50MB           | ~200-400MB       | ~20-40MB        |
| Learning curve (for a TS dev) | Medium             | Low              | Very high       |
| macOS native API access       | Via Rust plugin    | Via Node.js      | Direct          |
| File system performance       | Rust → Very high   | Node.js → Medium | Swift → High    |
| Security                      | Rust memory safety | JS sandbox       | Swift ARC       |
| Cross-platform potential      | ✅ Linux/Windows   | ✅ Linux/Windows | ❌ Apple only   |

**Decision: Tauri v2** — It combines the power of a TypeScript frontend with the performance of a Rust backend. For an I/O-heavy application like a file manager, the Rust backend provides a critical advantage.

---

## 2. Tech Stack — Exact Versions

| Category              | Technology       | Version      | Package                                     |
| --------------------- | ---------------- | ------------ | ------------------------------------------- |
| **Framework**         | Tauri            | 2.x (stable) | `@tauri-apps/cli`, `@tauri-apps/api`        |
| **Frontend**          | React            | 19.x         | `react`, `react-dom`                        |
| **Language**          | TypeScript       | 5.x          | `typescript`                                |
| **Build Tool**        | Vite             | 6.x          | `vite`                                      |
| **CSS**               | Tailwind CSS     | 4.x          | `tailwindcss`                               |
| **Components**        | shadcn/ui        | latest       | `npx shadcn@latest`                         |
| **Icons**             | Lucide React     | latest       | `lucide-react`                              |
| **State (Client)**    | Zustand          | 5.x          | `zustand`                                   |
| **Routing**           | TanStack Router  | 1.x          | `@tanstack/react-router`                    |
| **Terminal**          | xterm.js         | 5.x          | `@xterm/xterm`                              |
| **Terminal PTY**      | tauri-plugin-pty | 0.1.x        | `tauri-pty` (JS), `tauri-plugin-pty` (Rust) |
| **Virtualized Lists** | TanStack Virtual | 3.x          | `@tanstack/react-virtual`                   |
| **DnD**               | dnd-kit          | 6.x          | `@dnd-kit/core`, `@dnd-kit/sortable`        |
| **Context Menu**      | Radix UI         | latest       | `@radix-ui/react-context-menu`              |
| **Keyboard**          | Hotkeys.js       | latest       | `hotkeys-js`                                |
| **Date Format**       | date-fns         | 4.x          | `date-fns`                                  |
| **File Size Format**  | pretty-bytes     | 7.x          | `pretty-bytes`                              |
| **Animations**        | Framer Motion    | 11.x         | `framer-motion`                             |
| **Testing**           | Vitest           | 3.x          | `vitest`                                    |

### Official Tauri v2 Plugins (To Be Used)

| Plugin                           | Purpose                            | Cargo Crate                      |
| -------------------------------- | ---------------------------------- | -------------------------------- |
| `tauri-plugin-fs`                | File system read/write             | `tauri-plugin-fs`                |
| `tauri-plugin-dialog`            | Native open/save dialogs           | `tauri-plugin-dialog`            |
| `tauri-plugin-shell`             | Running external programs          | `tauri-plugin-shell`             |
| `tauri-plugin-os`                | Operating system information       | `tauri-plugin-os`                |
| `tauri-plugin-clipboard-manager` | Clipboard operations               | `tauri-plugin-clipboard-manager` |
| `tauri-plugin-notification`      | Notifications                      | `tauri-plugin-notification`      |
| `tauri-plugin-global-shortcut`   | Global shortcuts                   | `tauri-plugin-global-shortcut`   |
| `tauri-plugin-store`             | Storing settings/preferences       | `tauri-plugin-store`             |
| `tauri-plugin-window-state`      | Remembering window position        | `tauri-plugin-window-state`      |
| `tauri-plugin-opener`            | Opening a file in its default app  | `tauri-plugin-opener`            |

### Custom Rust Backend Commands (Custom Tauri Commands)

Custom commands to be written on the Rust side in Tauri v2 and called from TypeScript:

```
- fs_read_dir_deep      → Directory reading (metadata + hidden files + permissions)
- fs_watch              → Directory change watching via FSEvents
- fs_get_file_icon      → Fetching the native macOS file icon
- fs_get_disk_usage     → Disk usage information
- fs_trash              → Moving to the Trash (macOS Trash API)
- fs_spotlight_search   → Spotlight integration
- fs_get_extended_attrs → Reading xattrs (macOS metadata)
- fs_quick_look         → Quick Look preview data
- fs_get_volumes        → Listing mounted volumes
- fs_calculate_size     → Directory size calculation (async)
- fs_compress           → Zip/tar.gz compression
- fs_decompress         → Archive extraction
```

---

## 3. Architecture Design

### 3.1 Layered Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PRESENTATION LAYER                        │
│  React Components + Tailwind + shadcn/ui                    │
│  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌─────────────────┐  │
│  │ Toolbar │ │ FileList │ │ Preview │ │ Terminal Panel  │  │
│  │ TabBar  │ │ TreeView │ │ Panel   │ │ (xterm.js)      │  │
│  └─────────┘ └──────────┘ └─────────┘ └─────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│                    STATE LAYER (Zustand)                     │
│  ┌──────────────┐ ┌─────────────┐ ┌───────────────────┐    │
│  │ fileStore    │ │ tabStore    │ │ settingsStore     │    │
│  │ - entries    │ │ - tabs[]    │ │ - theme           │    │
│  │ - selection  │ │ - activeTab │ │ - layout          │    │
│  │ - clipboard  │ │ - history   │ │ - shortcuts       │    │
│  │ - sortOrder  │ │             │ │ - favorites       │    │
│  └──────────────┘ └─────────────┘ └───────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                    SERVICE LAYER (TypeScript)                │
│  ┌──────────┐ ┌────────────┐ ┌───────────┐ ┌──────────┐   │
│  │ FileOps  │ │ Navigation │ │ Search    │ │ Preview  │   │
│  │ Service  │ │ Service    │ │ Service   │ │ Service  │   │
│  └──────────┘ └────────────┘ └───────────┘ └──────────┘   │
├─────────────────────────────────────────────────────────────┤
│                 TAURI IPC BRIDGE                             │
│  invoke('command_name', { args }) ←→ Rust Commands          │
├─────────────────────────────────────────────────────────────┤
│                    RUST BACKEND (Tauri v2)                   │
│  ┌──────────────┐ ┌─────────────┐ ┌─────────────────────┐  │
│  │ FS Commands  │ │ OS Commands │ │ PTY Manager         │  │
│  │ (read, write │ │ (volumes,   │ │ (terminal sessions) │  │
│  │  watch, etc) │ │  spotlight) │ │                     │  │
│  └──────────────┘ └─────────────┘ └─────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Official Tauri Plugins (fs, dialog, shell, etc.)     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Window Layout

```
┌──────────────────────────────────────────────────────────────┐
│ ◉ ◉ ◉  │  OXplorer                                  │ ─ □ × │
├──────────────────────────────────────────────────────────────┤
│ ← → ↑ 🏠 │ /Users/ersin/Projects                    │ 🔍     │
├──────────────────────────────────────────────────────────────┤
│ Tab 1 │ Tab 2 │ Tab 3 │ +                                    │
├────────────┬─────────────────────┬───────────────────────────┤
│            │                     │                           │
│ SIDEBAR    │   LEFT PANE         │   RIGHT PANE              │
│            │                     │                           │
│ 💻 Macintosh│ 📁 node_modules    │ 📁 src                    │
│ 📁 Desktop │ 📁 src              │  📄 App.tsx               │
│ 📁 Documents│ 📁 public          │  📄 main.tsx              │
│ 📁 Downloads│ 📄 package.json    │  📁 components            │
│ 🏷 Favorites│ 📄 tsconfig.json   │  📁 hooks                 │
│            │ 📄 vite.config.ts   │  📁 stores                │
│ TAGS:      │                     │                           │
│ 🔴 Red     │─────────────────────│───────────────────────────│
│ 🟡 Yellow  │ 15 items │ 2.3 GB   │ 8 items │ 145 KB         │
├────────────┴─────────────────────┴───────────────────────────┤
│                                                              │
│ PREVIEW PANEL (toggle)                                       │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │  App.tsx — 2.4 KB — Modified: 2025-03-01                │ │
│ │  import React from 'react';                              │ │
│ │  export default function App() { ...                     │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ TERMINAL PANEL (toggle — xterm.js)                           │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ ersin@mac ~/Projects $ ls -la                            │ │
│ │ total 48                                                 │ │
│ │ drwxr-xr-x  12 ersin  staff   384 Mar  1 10:30 .        │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ 📁 /Users/ersin/Projects │ 23 items │ 4.2 GB free           │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Project File Structure

```
oxplorer/
├── src-tauri/                          # Rust Backend
│   ├── Cargo.toml                      # Rust dependencies
│   ├── tauri.conf.json                 # Tauri configuration
│   ├── capabilities/
│   │   └── default.json                # Permission configuration
│   ├── icons/                          # App icons
│   ├── src/
│   │   ├── main.rs                     # Tauri entry point
│   │   ├── lib.rs                      # Plugin registrations
│   │   ├── commands/
│   │   │   ├── mod.rs                  # Command exports
│   │   │   ├── fs_commands.rs          # File system commands
│   │   │   ├── os_commands.rs          # Operating system commands
│   │   │   ├── search_commands.rs      # Spotlight search
│   │   │   └── archive_commands.rs     # Compression/extraction
│   │   ├── watchers/
│   │   │   ├── mod.rs
│   │   │   └── fs_watcher.rs           # FSEvents file watching
│   │   ├── utils/
│   │   │   ├── mod.rs
│   │   │   ├── permissions.rs          # Unix permission parsing
│   │   │   ├── icons.rs                # macOS icon extraction
│   │   │   └── metadata.rs             # Extended attributes
│   │   └── types.rs                    # Shared Rust types
│   └── build.rs                        # Build script
│
├── src/                                # React Frontend
│   ├── main.tsx                        # React entry point
│   ├── App.tsx                         # Root component
│   ├── app/
│   │   ├── providers.tsx               # Context providers
│   │   ├── router.tsx                  # Route definitions
│   │   └── layout.tsx                  # Main layout
│   │
│   ├── components/
│   │   ├── ui/                         # shadcn/ui components
│   │   │   ├── button.tsx
│   │   │   ├── input.tsx
│   │   │   ├── dialog.tsx
│   │   │   ├── dropdown-menu.tsx
│   │   │   ├── context-menu.tsx
│   │   │   ├── tabs.tsx
│   │   │   ├── tooltip.tsx
│   │   │   ├── scroll-area.tsx
│   │   │   ├── separator.tsx
│   │   │   ├── badge.tsx
│   │   │   ├── slider.tsx
│   │   │   ├── switch.tsx
│   │   │   ├── toast.tsx
│   │   │   ├── command.tsx             # Command palette (Cmd+P)
│   │   │   └── resizable.tsx           # Panel resize
│   │   │
│   │   ├── layout/
│   │   │   ├── app-shell.tsx           # Main application shell
│   │   │   ├── title-bar.tsx           # Custom title bar (macOS)
│   │   │   ├── toolbar.tsx             # Navigation toolbar
│   │   │   ├── address-bar.tsx         # Path bar (breadcrumb + input)
│   │   │   ├── status-bar.tsx          # Bottom status bar
│   │   │   ├── sidebar.tsx             # Left sidebar (favorites + volumes)
│   │   │   └── panel-layout.tsx        # Resizable panel manager
│   │   │
│   │   ├── file-list/
│   │   │   ├── file-list-container.tsx # File list container (virtualized)
│   │   │   ├── file-list-header.tsx    # Column headers (sorting)
│   │   │   ├── file-list-item.tsx      # Single file row
│   │   │   ├── file-grid-item.tsx      # Grid view item
│   │   │   ├── file-icon.tsx           # File icon component
│   │   │   ├── file-rename-input.tsx   # In-place renaming
│   │   │   ├── column-view.tsx         # macOS column view
│   │   │   └── empty-state.tsx         # Empty directory state
│   │   │
│   │   ├── dual-pane/
│   │   │   ├── dual-pane-container.tsx # Two-pane manager
│   │   │   ├── pane.tsx                # Single pane
│   │   │   ├── pane-header.tsx         # Pane header + path
│   │   │   └── pane-sync.tsx           # Pane synchronization
│   │   │
│   │   ├── tabs/
│   │   │   ├── tab-bar.tsx             # Tab bar
│   │   │   ├── tab-item.tsx            # Single tab
│   │   │   └── tab-context-menu.tsx    # Tab right-click menu
│   │   │
│   │   ├── preview/
│   │   │   ├── preview-panel.tsx       # Preview panel container
│   │   │   ├── text-preview.tsx        # Text file preview
│   │   │   ├── image-preview.tsx       # Image preview
│   │   │   ├── video-preview.tsx       # Video preview
│   │   │   ├── audio-preview.tsx       # Audio preview
│   │   │   ├── pdf-preview.tsx         # PDF preview
│   │   │   ├── code-preview.tsx        # Code file (syntax highlight)
│   │   │   ├── markdown-preview.tsx    # Markdown render
│   │   │   └── file-info-preview.tsx   # File detail information
│   │   │
│   │   ├── terminal/
│   │   │   ├── terminal-panel.tsx      # Terminal panel
│   │   │   ├── terminal-instance.tsx   # xterm.js wrapper
│   │   │   ├── terminal-tabs.tsx       # Terminal tabs
│   │   │   └── terminal-toolbar.tsx    # Terminal toolbar
│   │   │
│   │   ├── dialogs/
│   │   │   ├── create-dialog.tsx       # New file/folder creation
│   │   │   ├── properties-dialog.tsx   # File properties
│   │   │   ├── permissions-dialog.tsx  # Permission editing
│   │   │   ├── compress-dialog.tsx     # Compression options
│   │   │   ├── conflict-dialog.tsx     # File conflict resolution
│   │   │   └── preferences-dialog.tsx  # Application settings
│   │   │
│   │   ├── search/
│   │   │   ├── search-bar.tsx          # Search bar
│   │   │   ├── search-results.tsx      # Search results
│   │   │   ├── search-filters.tsx      # Search filters
│   │   │   └── spotlight-search.tsx    # Spotlight integration
│   │   │
│   │   └── common/
│   │       ├── keyboard-shortcuts.tsx  # Shortcut manager
│   │       ├── drag-overlay.tsx        # Drag-and-drop indicator
│   │       ├── progress-indicator.tsx  # Operation progress bar
│   │       ├── breadcrumb-path.tsx     # Breadcrumb navigation
│   │       └── command-palette.tsx     # Cmd+Shift+P command palette
│   │
│   ├── hooks/
│   │   ├── use-file-operations.ts      # File CRUD operations
│   │   ├── use-navigation.ts           # Directory navigation
│   │   ├── use-selection.ts            # File selection logic
│   │   ├── use-clipboard.ts            # Cut/Copy/Paste
│   │   ├── use-keyboard-shortcuts.ts   # Shortcut hook
│   │   ├── use-drag-drop.ts            # Drag and drop
│   │   ├── use-file-watcher.ts         # File change watching
│   │   ├── use-search.ts               # Search hook
│   │   ├── use-sort.ts                 # Sorting hook
│   │   ├── use-context-menu.ts         # Right-click menu
│   │   ├── use-preview.ts              # Preview logic
│   │   ├── use-terminal.ts             # Terminal management
│   │   ├── use-dual-pane.ts            # Dual-pane logic
│   │   └── use-debounce.ts             # Debounce utility
│   │
│   ├── stores/
│   │   ├── file-store.ts               # File list + selection state
│   │   ├── tab-store.ts                # Tab management state
│   │   ├── layout-store.ts             # Panel sizes + view
│   │   ├── settings-store.ts           # Application settings
│   │   ├── clipboard-store.ts          # Clipboard state (cut/copy)
│   │   ├── history-store.ts            # Navigation history
│   │   ├── search-store.ts             # Search state
│   │   └── terminal-store.ts           # Terminal sessions
│   │
│   ├── services/
│   │   ├── tauri-bridge.ts             # Tauri IPC wrapper
│   │   ├── file-service.ts             # File operation service
│   │   ├── navigation-service.ts       # Navigation service
│   │   ├── search-service.ts           # Search service
│   │   ├── preview-service.ts          # Preview service
│   │   ├── clipboard-service.ts        # Clipboard service
│   │   └── archive-service.ts          # Archive service
│   │
│   ├── types/
│   │   ├── file.ts                     # FileEntry, FileMetadata types
│   │   ├── tab.ts                      # Tab types
│   │   ├── layout.ts                   # Layout types
│   │   ├── settings.ts                 # Settings types
│   │   ├── events.ts                   # Event types
│   │   └── commands.ts                 # Tauri command types
│   │
│   ├── lib/
│   │   ├── utils.ts                    # General helpers
│   │   ├── constants.ts                # Constants
│   │   ├── file-utils.ts               # File helpers
│   │   ├── path-utils.ts               # Path helpers
│   │   ├── format-utils.ts             # Formatting (size, date)
│   │   ├── icon-utils.ts               # Icon mapping by extension
│   │   ├── mime-utils.ts               # MIME type detection
│   │   └── keyboard-maps.ts            # Shortcut map
│   │
│   ├── styles/
│   │   ├── globals.css                 # Global styles + Tailwind
│   │   ├── themes/
│   │   │   ├── light.css               # Light theme
│   │   │   └── dark.css                # Dark theme
│   │   └── xterm-theme.css             # Terminal theme style
│   │
│   └── assets/
│       ├── icons/                      # SVG icons
│       └── fonts/                      # JetBrains Mono (terminal)
│
├── public/
│   └── tauri-icon.png
│
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── components.json                     # shadcn/ui config
├── .eslintrc.json
├── .prettierrc
└── README.md
```

---

## 5. TypeScript Type Definitions (Core)

```typescript
// types/file.ts

/** File system entry */
export interface FileEntry {
  /** Full file path */
  path: string;
  /** File/folder name */
  name: string;
  /** File extension (.ts, .md, etc.) */
  extension: string | null;
  /** Is it a folder? */
  isDirectory: boolean;
  /** Is it a symbolic link? */
  isSymlink: boolean;
  /** Is it a hidden file? (starts with .) */
  isHidden: boolean;
  /** File size (bytes) */
  size: number;
  /** Last modification date (ISO string) */
  modifiedAt: string;
  /** Creation date */
  createdAt: string;
  /** Last access date */
  accessedAt: string;
  /** Unix permissions (octal string: "755") */
  permissions: string;
  /** Owner user */
  owner: string;
  /** Owner group */
  group: string;
  /** macOS Finder tags/colors */
  tags: string[];
  /** MIME type */
  mimeType: string | null;
}

/** Disk/Volume information */
export interface VolumeInfo {
  name: string;
  mountPoint: string;
  totalSpace: number;
  availableSpace: number;
  fileSystem: string;
  isRemovable: boolean;
  isExternal: boolean;
}

/** File operation types */
export type FileOperation =
  | { type: "copy"; sources: string[]; destination: string }
  | { type: "move"; sources: string[]; destination: string }
  | { type: "delete"; paths: string[] }
  | { type: "trash"; paths: string[] }
  | { type: "rename"; path: string; newName: string }
  | { type: "create_file"; path: string; name: string }
  | { type: "create_dir"; path: string; name: string };

/** File conflict resolution strategy */
export type ConflictResolution = "overwrite" | "skip" | "rename" | "overwrite_all" | "skip_all";

/** Sorting options */
export interface SortConfig {
  field: "name" | "size" | "modified" | "created" | "extension" | "type";
  direction: "asc" | "desc";
  foldersFirst: boolean;
}

/** View mode */
export type ViewMode = "list" | "grid" | "columns" | "gallery";

// types/tab.ts

/** Tab state */
export interface Tab {
  id: string;
  path: string;
  label: string;
  isPinned: boolean;
  paneId: "left" | "right";
  history: string[];
  historyIndex: number;
}

// types/layout.ts

/** Panel configuration */
export interface LayoutConfig {
  sidebarWidth: number;
  sidebarVisible: boolean;
  dualPaneEnabled: boolean;
  leftPaneWidth: number; // percent
  previewPanelVisible: boolean;
  previewPanelHeight: number;
  terminalVisible: boolean;
  terminalHeight: number;
  viewMode: ViewMode;
  showHiddenFiles: boolean;
  showFileExtensions: boolean;
  showStatusBar: boolean;
}

// types/settings.ts

/** Application settings */
export interface AppSettings {
  theme: "light" | "dark" | "system";
  accentColor: string;
  fontSize: number;
  fontFamily: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalShell: string; // "/bin/zsh"
  defaultViewMode: ViewMode;
  confirmDelete: boolean;
  confirmTrash: boolean;
  showHiddenByDefault: boolean;
  singleClickToOpen: boolean;
  defaultSortConfig: SortConfig;
  favorites: FavoriteItem[];
  recentPaths: string[];
}

export interface FavoriteItem {
  name: string;
  path: string;
  icon?: string;
}
```

---

## 6. Zustand Store Structures

### 6.1 File Store

```typescript
// stores/file-store.ts
interface FileStoreState {
  // File list of the active pane
  entries: FileEntry[];
  loading: boolean;
  error: string | null;

  // Selection
  selectedPaths: Set<string>;
  lastSelectedPath: string | null;
  selectionAnchor: string | null;

  // Clipboard
  clipboardPaths: string[];
  clipboardOperation: "copy" | "cut" | null;

  // Sorting
  sortConfig: SortConfig;

  // Filter
  filterText: string;
  showHidden: boolean;

  // Actions
  loadDirectory: (path: string) => Promise<void>;
  selectFile: (path: string, mode: "single" | "toggle" | "range") => void;
  selectAll: () => void;
  clearSelection: () => void;
  setSortConfig: (config: SortConfig) => void;
  setFilterText: (text: string) => void;
  toggleHidden: () => void;
  copyToClipboard: (paths: string[]) => void;
  cutToClipboard: (paths: string[]) => void;
  paste: (destination: string) => Promise<void>;
  deleteSelected: () => Promise<void>;
  trashSelected: () => Promise<void>;
  renameFile: (path: string, newName: string) => Promise<void>;
  createFile: (name: string) => Promise<void>;
  createDirectory: (name: string) => Promise<void>;
  refresh: () => Promise<void>;
}
```

### 6.2 Tab Store

```typescript
// stores/tab-store.ts
interface TabStoreState {
  tabs: Tab[];
  activeTabId: string;

  // Actions
  addTab: (path: string, paneId?: "left" | "right") => void;
  closeTab: (tabId: string) => void;
  closeOtherTabs: (tabId: string) => void;
  closeTabsToRight: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabPath: (tabId: string, path: string) => void;
  pinTab: (tabId: string) => void;
  unpinTab: (tabId: string) => void;
  moveTab: (tabId: string, newIndex: number) => void;
  duplicateTab: (tabId: string) => void;
  navigateBack: (tabId: string) => void;
  navigateForward: (tabId: string) => void;
  navigateUp: (tabId: string) => void;
}
```

---

## 7. Keyboard Shortcuts

| Shortcut           | Action                       | Windows Equivalent |
| ------------------ | ---------------------------- | ------------------ |
| `Cmd+C`            | Copy                         | Ctrl+C             |
| `Cmd+X`            | Cut                          | Ctrl+X             |
| `Cmd+V`            | Paste                        | Ctrl+V             |
| `Cmd+Z`            | Undo                         | Ctrl+Z             |
| `Cmd+A`            | Select all                   | Ctrl+A             |
| `Cmd+N`            | New file                     | Ctrl+N             |
| `Cmd+Shift+N`      | New folder                   | Ctrl+Shift+N       |
| `Cmd+Delete`       | Move to Trash                | Delete             |
| `Cmd+Shift+Delete` | Delete permanently           | Shift+Delete       |
| `Cmd+D`            | Delete                       | -                  |
| `Enter`            | Rename                       | F2                 |
| `Cmd+O`            | Open file                    | Enter              |
| `Space`            | Quick Look preview           | -                  |
| `Cmd+F`            | Search files                 | Ctrl+F             |
| `Cmd+Shift+F`      | Spotlight search             | -                  |
| `Cmd+T`            | New tab                      | Ctrl+T             |
| `Cmd+W`            | Close tab                    | Ctrl+W             |
| `Cmd+1-9`          | Go to tab                    | Ctrl+1-9           |
| `Cmd+[`            | Go back                      | Alt+←              |
| `Cmd+]`            | Go forward                   | Alt+→              |
| `Cmd+↑`            | Go to parent directory       | Alt+↑              |
| `Cmd+↓`            | Enter folder / Open file     | -                  |
| `Cmd+Shift+.`      | Show/hide hidden files       | -                  |
| `Cmd+I`            | File info                    | Alt+Enter          |
| `Cmd+P`            | Command palette              | Ctrl+P             |
| `Cmd+\``           | Toggle terminal              | Ctrl+`             |
| `Cmd+Shift+P`      | Command palette              | Ctrl+Shift+P       |
| `Tab`              | Switch between panes         | Tab                |
| `Cmd+1`            | List view                    | -                  |
| `Cmd+2`            | Grid view                    | -                  |
| `Cmd+3`            | Column view                  | -                  |
| `F5`               | Refresh                      | F5                 |

---

## 8. Development Phases (Phase Plan)

### PHASE 1: Core Infrastructure (Week 1-2)

**Goal:** Set up the project skeleton and get Tauri + React running

- [ ] Create the Tauri v2 + Vite + React + TypeScript project
- [ ] Install Tailwind CSS v4 + shadcn/ui
- [ ] Register Tauri plugins (fs, dialog, shell, os, store)
- [ ] Write TypeScript type definitions
- [ ] Create the skeleton of the Zustand stores
- [ ] Write core Rust commands (fs_read_dir, fs_stat)
- [ ] Tauri capability/permission configuration
- [ ] Custom title bar (macOS traffic lights)
- [ ] Basic layout (sidebar + main area + status bar)
- [ ] Get Vite HMR + Tauri dev mode working

### PHASE 2: File List & Navigation (Week 3-4)

**Goal:** Basic file display and navigation

- [ ] File list (virtualized - TanStack Virtual)
- [ ] List view (detail view - columns)
- [ ] Grid view (icon view)
- [ ] Sorting (name, size, date, type)
- [ ] Breadcrumb navigation + editable address bar
- [ ] Back/Forward/Up navigation
- [ ] Hidden files toggle
- [ ] File icons (Lucide icons by extension)
- [ ] Sidebar (Favorites + Volumes)
- [ ] Directory change watching (FSEvents → Rust watcher)
- [ ] Empty directory state
- [ ] Loading state

### PHASE 3: File Operations (Week 5-6)

**Goal:** Basic CRUD and file management

- [ ] Copy/Cut/Paste
- [ ] Drag and drop (dnd-kit)
- [ ] File/Folder creation
- [ ] Renaming (inline edit)
- [ ] Moving to Trash (macOS Trash API)
- [ ] Permanent deletion (with confirmation dialog)
- [ ] File conflict resolution dialog
- [ ] Progress indicator (large copy operations)
- [ ] Undo support
- [ ] Context menu (right-click) — Radix UI

### PHASE 4: Tab System (Week 7)

**Goal:** Multi-tab support

- [ ] Tab bar UI
- [ ] Opening/closing new tabs
- [ ] Reordering tabs by dragging
- [ ] Tab pinning (pin)
- [ ] Tab context menu (close, close others, close to the right)
- [ ] Independent navigation history per tab
- [ ] Switching to a tab with Cmd+1-9
- [ ] Cmd+T / Cmd+W shortcuts
- [ ] Saving tab state (session persistence)

### PHASE 5: Dual-Pane (Week 8-9)

**Goal:** Total Commander-style dual pane

- [ ] Dual-pane layout (resizable)
- [ ] Independent navigation for left/right panes
- [ ] Copying/moving files between panes
- [ ] Drag and drop between panes
- [ ] Switching the active pane with Tab
- [ ] Independent tabs for each pane
- [ ] Synchronized browsing mode (optional)
- [ ] Remembering pane size

### PHASE 6: File Preview (Week 10-11)

**Goal:** Quick Look-style preview

- [ ] Preview panel (bottom or right)
- [ ] Text file preview (syntax highlighting)
- [ ] Image preview (jpg, png, gif, webp, svg)
- [ ] PDF preview
- [ ] Video preview (mp4, webm)
- [ ] Audio preview (mp3, wav, ogg)
- [ ] Markdown render
- [ ] Syntax highlighting for code files
- [ ] File info panel (size, date, permissions)
- [ ] Quick Look toggle with the Space key
- [ ] Remembering preview panel size

### PHASE 7: Integrated Terminal (Week 12-13)

**Goal:** Fully functional terminal panel

- [ ] xterm.js integration
- [ ] PTY connection via tauri-plugin-pty
- [ ] Terminal panel (bottom panel, toggle)
- [ ] Terminal tabs (multiple sessions)
- [ ] Automatic cd into the active directory
- [ ] Terminal theme support (matching the file manager theme)
- [ ] Terminal font settings (JetBrains Mono)
- [ ] Terminal resizing
- [ ] Feedback from the terminal to the file manager
- [ ] Copy/Paste support

### PHASE 8: Search & Spotlight (Week 14)

**Goal:** Powerful file search

- [ ] Local file search (name filter)
- [ ] Spotlight integration (mdfind Rust wrapper)
- [ ] Search filters (type, size, date)
- [ ] Search results list
- [ ] Command palette (Cmd+Shift+P)
- [ ] File content search (grep Rust wrapper)

### PHASE 9: Settings & Theme (Week 15)

**Goal:** Customization and user preferences

- [ ] Settings dialog
- [ ] Light/Dark/System theme
- [ ] Font size setting
- [ ] Default view mode
- [ ] Shortcut customization
- [ ] Favorites management
- [ ] Terminal shell selection
- [ ] Saving settings to disk (tauri-plugin-store)
- [ ] Remembering window state (tauri-plugin-window-state)

### PHASE 10: Polish & Release (Week 16-17)

**Goal:** Final touches and distribution

- [ ] Creating the macOS DMG
- [ ] App icon design
- [ ] Performance optimization
- [ ] Accessibility (keyboard-only navigation)
- [ ] Error capturing and reporting
- [ ] README and documentation
- [ ] GitHub Actions CI/CD
- [ ] Homebrew cask formula
- [ ] First release (v0.1.0)

---

## 9. macOS Development Prerequisites

### Required Installations

```bash
# 1. Xcode Command Line Tools (required)
xcode-select --install

# 2. Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable

# 3. Node.js (v22 LTS)
# via fnm or nvm
fnm install 22
fnm default 22

# 4. pnpm (recommended package manager)
npm install -g pnpm

# 5. Tauri CLI
pnpm add -g @tauri-apps/cli
```

### macOS-Specific Notes (For First-Time macOS Users)

**File System Differences:**
- macOS uses APFS (Apple File System) — case-insensitive but case-preserving
- The path separator is `/` (not `\` as on Windows)
- Home directory: `/Users/<user>/`
- Applications directory: `/Applications/`
- Hidden files start with `.` (not the attrib hidden flag as on Windows)
- `.DS_Store` files appear in every directory — ignore them
- On macOS the "Trash" is the `~/.Trash/` directory
- Extended attributes (xattr) → file tags, quarantine info, etc.
- The `@` symbol in `ls -l` output indicates that xattrs are present

**Permission System:**
- macOS Catalina+ security layers: SIP, TCC, Gatekeeper
- Tauri apps may request "Full Disk Access" (System Settings > Privacy)
- Code signing may be required to run outside the sandbox
- In dev mode with `tauri dev` there is no sandbox restriction

---

## 10. Tauri v2 Basic Configuration

### tauri.conf.json (Template)

```json
{
  "productName": "OXplorer",
  "version": "0.1.0",
  "identifier": "com.ecostack.oxplorer",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "pnpm dev",
    "beforeBuildCommand": "pnpm build"
  },
  "app": {
    "windows": [
      {
        "title": "OXplorer",
        "width": 1280,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "decorations": false,
        "transparent": false,
        "titleBarStyle": "Overlay"
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": {
      "minimumSystemVersion": "10.15",
      "frameworks": [],
      "signingIdentity": null
    }
  }
}
```

### capabilities/default.json (Permissions)

```json
{
  "identifier": "default",
  "description": "OXplorer default capabilities",
  "windows": ["main"],
  "permissions": [
    "core:default",
    {
      "identifier": "fs:default",
      "allow": [{ "path": "$HOME/**" }, { "path": "/**" }]
    },
    "fs:allow-read",
    "fs:allow-write",
    "fs:allow-exists",
    "fs:allow-mkdir",
    "fs:allow-remove",
    "fs:allow-rename",
    "fs:allow-copy-file",
    "fs:allow-stat",
    "fs:allow-lstat",
    "fs:allow-read-dir",
    "fs:allow-read-file",
    "fs:allow-write-file",
    "fs:allow-read-text-file",
    "fs:allow-write-text-file",
    "dialog:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "dialog:allow-message",
    "dialog:allow-confirm",
    "shell:default",
    "shell:allow-spawn",
    "shell:allow-execute",
    "clipboard-manager:default",
    "clipboard-manager:allow-read",
    "clipboard-manager:allow-write",
    "notification:default",
    "global-shortcut:default",
    "global-shortcut:allow-register",
    "os:default",
    "store:default",
    "window-state:default"
  ]
}
```

---

## 11. Rust Backend Example Commands

### fs_commands.rs (Template)

```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::command;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub extension: Option<String>,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub size: u64,
    pub modified_at: String,
    pub created_at: String,
    pub accessed_at: String,
    pub permissions: String,
    pub owner: String,
    pub group: String,
    pub tags: Vec<String>,
    pub mime_type: Option<String>,
}

#[command]
pub async fn fs_read_dir(path: String, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    let dir_path = PathBuf::from(&path);

    if !dir_path.exists() {
        return Err(format!("Directory not found: {}", path));
    }

    let mut entries = Vec::new();

    let read_dir = fs::read_dir(&dir_path)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let metadata = entry.metadata()
            .map_err(|e| format!("Failed to read metadata: {}", e))?;

        let name = entry.file_name().to_string_lossy().to_string();

        // Hidden file check
        if !show_hidden && name.starts_with('.') {
            continue;
        }

        let file_entry = FileEntry {
            path: entry.path().to_string_lossy().to_string(),
            name: name.clone(),
            extension: entry.path().extension()
                .map(|e| e.to_string_lossy().to_string()),
            is_directory: metadata.is_dir(),
            is_symlink: metadata.file_type().is_symlink(),
            is_hidden: name.starts_with('.'),
            size: metadata.len(),
            modified_at: format_system_time(metadata.modified().ok()),
            created_at: format_system_time(metadata.created().ok()),
            accessed_at: format_system_time(metadata.accessed().ok()),
            permissions: format_permissions(&metadata),
            owner: get_owner(&metadata),
            group: get_group(&metadata),
            tags: Vec::new(), // macOS tags will be implemented separately
            mime_type: guess_mime_type(&entry.path()),
        };

        entries.push(file_entry);
    }

    Ok(entries)
}

#[command]
pub async fn fs_trash(paths: Vec<String>) -> Result<(), String> {
    for path in &paths {
        trash::delete(path)
            .map_err(|e| format!("Failed to trash {}: {}", path, e))?;
    }
    Ok(())
}

#[command]
pub async fn fs_calculate_size(path: String) -> Result<u64, String> {
    let mut total: u64 = 0;
    calculate_dir_size(&PathBuf::from(&path), &mut total)
        .map_err(|e| format!("Failed to calculate size: {}", e))?;
    Ok(total)
}

fn calculate_dir_size(path: &PathBuf, total: &mut u64) -> std::io::Result<()> {
    if path.is_file() {
        *total += fs::metadata(path)?.len();
    } else if path.is_dir() {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            calculate_dir_size(&entry.path(), total)?;
        }
    }
    Ok(())
}
```

---

## 12. Reference macOS File Managers (Inspiration)

| Application          | Price        | Feature                         |
| -------------------- | ------------ | ------------------------------- |
| **Finder** (default) | Free         | macOS native, column view       |
| **Forklift 4**       | $29.95       | Dual-pane, terminal, FTP        |
| **Path Finder**      | $36          | Dual pane, terminal, modular    |
| **Commander One**    | Freemium     | Total Commander-like            |
| **QSpace Pro**       | $4.99        | Quad-pane, lightweight          |
| **Double Commander** | Free/OSS     | Total Commander clone           |
| **muCommander**      | Free/OSS     | Java, cross-platform            |

**What Sets OXplorer Apart:** TypeScript/Rust based, modern UI, open source, community-driven.

---

## 13. Performance Targets

| Metric                     | Target       | How?                               |
| -------------------------- | ------------ | ---------------------------------- |
| Initial startup time       | < 1 second   | Tauri lightweight binary           |
| Listing 10,000 files       | < 500ms      | Rust fs reading + virtualized list |
| Listing 100,000 files      | < 2 seconds  | Streaming + pagination             |
| File copy throughput       | > 500 MB/s   | Rust native copy                   |
| RAM usage (idle)           | < 50 MB      | Tauri WebView + minimal state      |
| RAM usage (heavy)          | < 150 MB     | Virtualized rendering              |
| Binary size                | < 10 MB      | Tauri + tree shaking               |

---

## 14. Security Measures

1. **Tauri ACL:** Restrict the APIs the frontend can access via the capability file
2. **Scope restrictions:** Define the allowed directories via the fs plugin scope
3. **Path traversal protection:** The Tauri fs plugin automatically blocks `../`
4. **Shell injection protection:** Restrict executable commands via the shell plugin scope
5. **CSP:** XSS protection via the Content Security Policy header
6. **No eval():** eval/the Function constructor will not be used in the frontend
7. **Rust memory safety:** Buffer overflows and use-after-free are prevented automatically
8. **Code signing:** Signing with an Apple Developer Certificate for distribution

---

## 15. Important Notes for Claude Code

### macOS-Specific Things to Watch Out For

1. **Title bar:** The macOS traffic light buttons (red/yellow/green) will overlap with `titleBarStyle: "Overlay"` — leave padding in the custom title bar
2. **Cmd vs Ctrl:** Use `Cmd` in all shortcuts, not `Ctrl`
3. **Drag & Drop:** macOS native drag sessions are managed by Tauri
4. **Font rendering:** macOS sub-pixel rendering is different — add a font smoothing setting
5. **Dark mode:** `prefers-color-scheme` + macOS system appearance API
6. **HiDPI:** Retina display support is automatic (Tauri handles it)
7. **Notarization:** Notarization is required for distribution outside the Mac App Store

### Crates to Use on the Rust Side

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"
tauri-plugin-os = "2"
tauri-plugin-clipboard-manager = "2"
tauri-plugin-notification = "2"
tauri-plugin-global-shortcut = "2"
tauri-plugin-store = "2"
tauri-plugin-window-state = "2"
tauri-plugin-opener = "2"
tauri-plugin-pty = "0.1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
notify = "7"                    # File system watching
trash = "5"                     # Moving to the Trash
mime_guess = "2"                # MIME type guessing
walkdir = "2"                   # Recursive directory walking
chrono = "0.4"                  # Date formatting
flate2 = "1"                   # gzip compression
zip = "2"                      # ZIP archive support
tar = "0.4"                    # TAR archive support
```

---

## 16. Test Strategy

```
Vitest (Unit)          → Utility functions, store logic
React Testing Library  → Component render tests
Playwright             → E2E (Tauri + WebDriver)
Rust #[cfg(test)]      → Backend command tests
```

---

## CLAUDE CODE PROMPT — Ready to Use

You can kick off Phase 1 by using the prompt below in Claude Code:

---

```
# OXplorer — Phase 1: Project Infrastructure

Create a Tauri v2 + React 19 + TypeScript file manager application for macOS.

## Project Creation Commands

1. Create the project with the `pnpm create tauri-app oxplorer --template react-ts` command
2. `cd oxplorer` 
3. Install Tailwind CSS v4, shadcn/ui, zustand, lucide-react, @tanstack/react-virtual, date-fns, pretty-bytes with pnpm
4. Initialize shadcn/ui with `npx shadcn@latest init` and add these components: button, input, dialog, dropdown-menu, context-menu, tabs, tooltip, scroll-area, separator, badge, command, resizable

## src-tauri Configuration

### tauri.conf.json
- productName: "OXplorer"
- identifier: "com.ecostack.oxplorer"  
- Window: 1280x800, min 800x600
- titleBarStyle: "Overlay" (macOS native traffic lights)
- decorations: false

### capabilities/default.json
- $HOME/** and /** access via the fs plugin
- dialog, shell, clipboard-manager, os, store, window-state, global-shortcut, notification, opener plugins

### Cargo.toml
Add these crates: tauri-plugin-fs, tauri-plugin-dialog, tauri-plugin-shell, tauri-plugin-os, tauri-plugin-clipboard-manager, tauri-plugin-store, tauri-plugin-window-state, tauri-plugin-opener, serde (derive), serde_json, tokio (full), notify 7, trash 5, mime_guess, walkdir, chrono

### src/main.rs & lib.rs
Register all plugins and wire up the custom commands module.

### src/commands/fs_commands.rs
- Write the `fs_read_dir(path: String, show_hidden: bool) -> Vec<FileEntry>` command
- FileEntry struct: path, name, extension, is_directory, is_symlink, is_hidden, size, modified_at, created_at, permissions, owner, group, mime_type
- Write the `fs_trash(paths: Vec<String>)` command
- Write the `fs_get_volumes() -> Vec<VolumeInfo>` command

## Frontend Structure

### TypeScript Types (src/types/)
- file.ts: FileEntry, VolumeInfo, FileOperation, SortConfig, ViewMode
- tab.ts: Tab interface
- layout.ts: LayoutConfig
- settings.ts: AppSettings

### Zustand Stores (src/stores/)
- file-store.ts: entries, selection, clipboard, sort, filter, CRUD actions
- tab-store.ts: tabs, activeTabId, tab CRUD
- layout-store.ts: panel sizes, view mode
- settings-store.ts: theme, font, preferences

### Tauri Bridge (src/services/tauri-bridge.ts)
Type-safe wrapper functions that call the Rust commands.

### Layout Components
- app-shell.tsx: Main layout (sidebar + content + panels)  
- title-bar.tsx: Custom macOS title bar (72px padding on the left for the traffic lights)
- toolbar.tsx: ← → ↑ 🏠 buttons + address bar + search
- address-bar.tsx: Breadcrumb path + editable path that turns into an input when clicked
- sidebar.tsx: Volumes list + Favorites + Tags
- status-bar.tsx: Selected file count, total size, disk space
- panel-layout.tsx: sidebar + main content with shadcn/ui ResizablePanel

### File List Components
- file-list-container.tsx: Virtualized list with TanStack Virtual
- file-list-header.tsx: Name | Size | Modified | Kind columns, click = sort
- file-list-item.tsx: Single file row, selection highlight, hover effect
- file-icon.tsx: Lucide icon mapping by extension

## Style Rules
- Use Tailwind CSS v4
- Dark/Light theme support (via CSS variables)
- macOS native feel: blur effects, soft shadows, 8px border-radius
- Font: Inter (UI) + JetBrains Mono (monospace/terminal)
- Sidebar background: semi-transparent (macOS vibrancy-like effect)

## TypeScript Rules  
- strict: true, noUncheckedIndexedAccess: true
- Never use `any`; prefer `unknown` + type guards
- Explicit return types on all public APIs
- File names in kebab-case, components in PascalCase
- Path alias: @/ → src/

## First Run Test
With the `pnpm tauri dev` command:
1. A macOS window should open (custom title bar + traffic lights)
2. Volumes and favorites should be visible in the sidebar  
3. The user's home directory should be listed in the main area
4. The file count and disk space should be visible in the status bar
5. The active path should be shown in the address bar
```

---

> **Next Step:** Run this Phase 1 prompt in Claude Code. Once it's done, I can prepare the Phase 2 prompt.
> 
> **Total Project Estimate:** ~17 weeks (one developer, part-time)
> **MVP (Phase 1-4):** ~7 weeks — Core file manager + tab support
> **Full Feature (Phase 1-10):** ~17 weeks — All features + polish
