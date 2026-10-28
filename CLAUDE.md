# OXplorer — Claude Code rules

Modern dual-pane file manager for macOS. Plan and rationale: `oxplorer-project-plan-v2.md` (architecture decisions in §0.2, §3, §6, §7 are binding).

## Stack
Tauri 2.12 · React 19 (React Compiler on) · TypeScript 7 · Vite 8 · Tailwind 4 · Zustand 5 + Immer · Biome 2 · Rust 2024 edition

## Commands
- Dev: `pnpm tauri dev` — open a specific folder: `pnpm tauri dev -- -- /path/to/dir`
- After every change: `pnpm check` (biome + tsc + vitest) and `pnpm check:rust` (fmt + clippy -D warnings + tests)
- Regenerate IPC types: `pnpm bindings` → `src/bindings.ts`
- Benchmark fixture: `scripts/gen-fixture.sh /tmp/ox-100k 100000`
- Webview errors, CSP violations and listing timings are forwarded to the Rust log (stdout in dev).
- In-app IPC self-test of file operations: `OX_SELFTEST_DIR=/empty/dir pnpm tauri dev -- -- /empty/dir` (results in the log as `selftest ok|FAIL`).
- Release benchmarks (ignored tests): `bench_list` (OX_BENCH_DIR), `bench_copy` (OX_BENCH_SRC, OX_BENCH_DEST, OX_BENCH_CANCEL_AFTER).
- Native menu owns ⌘C/⌘X/⌘V/⌘Z/⌘⌫; `src/lib/text-edit.ts` forwards them to focused text fields.
- Tabs/layout persist in `session.json` (`src/stores/session.ts`); panes list their folder when it becomes visible (`ensureListed`), `navigateTo` only changes state.
- Preview media goes through `asset:`; call `allow_preview` first (scope starts empty). Quick Look: `src-tauri/src/mac/quicklook.rs`.
- Terminal: `src-tauri/src/pty/` (sessions + zsh OSC 7 shim), `src/features/terminal/`. Edit-menu commands check `focusedTerminal()` before text fields and files. Machine-dependent test: `cargo test --lib pty -- --ignored` (htop).
- Servers: `remote:<connection id>/path` (`src/lib/remote-path.ts`, `src-tauri/src/remote.rs`, OpenDAL). Connections live in preferences, secrets only in the Keychain. `src/commands/locations.ts` picks the job for copies between local, archive and remote (`transferSpec`) and makes real temp files (`materialize`).
- Archives are virtual folders too: `archive:/x.zip!/inner` (`src/lib/archive-path.ts`, `src-tauri/src/archive_fs.rs`); `isVirtualPath()` covers both kinds.
- Search results are a virtual folder: `search:?…` paths (`src/lib/search-path.ts`), streamed into `dir-cache-store` from `src-tauri/src/search/`. Code that needs a real folder uses `currentFolder()` / `writableFolder()`. Benchmarks: `bench_content_home` (OX_BENCH_DIR, OX_BENCH_QUERY, OX_BENCH_CANCEL_MS).
- Settings window: `settings.html` → `src/settings-main.tsx`, capability `capabilities/settings.json` (no FS commands). It writes `settings.json`; the main window picks changes up via `watchPreferences()`. Menu commands only run in the focused window (`listenToMenu`).
- Menu shortcuts: defaults in `src-tauri/src/menu.rs`, user overrides applied with `set_shortcuts` (validated, rebuilds the menu bar).
- UI text: English in code, wrapped in `t()` / `tn()` (components: `useT()`), constants marked with `msg()`; Turkish in `src/i18n/tr.ts`. `src/i18n/i18n.test.ts` fails on missing/unused keys. Native menu labels go to Rust via `set_menu_titles`. Logs stay English.
- Finder extension: `extensions/finder-sync` (Swift), built by `scripts/build-finder-extension.sh` before bundling and embedded as `Contents/PlugIns/OXplorerFinder.appex`; not part of `tauri dev`.
- In dev, Vite reloads the page once after new dependencies are installed; the self-test then runs twice — rerun with an empty folder.

## Rules
- `src/bindings.ts` is GENERATED. Change the Rust type/command, then `pnpm bindings`.
- The frontend never touches the disk directly. Do NOT add `@tauri-apps/plugin-fs` or `plugin-shell` permissions.
- New Rust command: `#[tauri::command] #[specta::specta]`, return `AppResult<T>`, add to `collect_commands!` in `lib.rs`, to `COMMANDS` in `build.rs`, and `allow-<name>` in `capabilities/main.json`.
- Every incoming path goes through `security::validate_path`. Blocking FS work runs in `spawn_blocking`.
- Lists/progress stream through `tauri::ipc::Channel<T>`; never return large `Vec`s. Channel messages may arrive after the command resolves — completion is an in-band event (`DirEvent::Done`).
- 64-bit integers cross IPC as `number`: annotate with `#[specta(type = u32)]` (see `model.rs`).
- Timestamps are epoch ms; formatting happens in the frontend.
- User actions are commands in `src/commands/` (registry). Native menu accelerators live in `src-tauri/src/menu.rs` and must not be bound again in `keymap.ts`.
- State is pane → tab scoped (`workspace-store`). No global "current directory".
- TS: strict + `noUncheckedIndexedAccess`, no `any`, kebab-case files, `@/` → `src/`.
- Rust: no `unwrap()` outside tests; user-facing errors go through `AppError`.
- Shortcuts follow Finder (plan §8): Cmd, not Ctrl.
