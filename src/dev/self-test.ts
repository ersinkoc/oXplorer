import { Channel, convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { info, error as logError } from "@tauri-apps/plugin-log";
import { commands, type MeasureEvent } from "@/bindings";
import { runJob } from "@/commands/jobs";
import { navigateTo } from "@/commands/navigation";
import { closeTerminal, openTerminal } from "@/commands/terminal-commands";
import { terminalById } from "@/features/terminal/terminal-registry";
import { menuTitles } from "@/i18n";
import { MENU_LABELS } from "@/i18n/menu-labels";
import { highlight } from "@/lib/highlight";
import { unwrap } from "@/lib/ipc";
import { join } from "@/lib/path";
import { searchPath } from "@/lib/search-path";
import { shellQuote } from "@/lib/shell";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { useSearchInfo } from "@/stores/search-store";
import { useTerminals } from "@/stores/terminal-store";
import { getActiveTab } from "@/stores/workspace-store";

/**
 * Dev-only end-to-end check of the file-operation IPC path (start with
 * `OX_SELFTEST_DIR=/some/empty/dir pnpm tauri dev`). Results go to the log.
 */
export async function runSelfTest(): Promise<void> {
  const dir = await commands.selfTestDir();
  if (!dir) return;
  const step = (name: string, ok: boolean, detail = "") =>
    void (ok ? info(`selftest ok: ${name} ${detail}`) : logError(`selftest FAIL: ${name} ${detail}`));
  try {
    const folder = await unwrap(commands.createItem(dir, "selftest folder", true));
    const note = await unwrap(commands.createItem(dir, "note.txt", false));
    step("create", folder.kind === "dir" && note.name === "note.txt");

    const copied = await runJob(
      { kind: "copy", sources: [note.path], destDir: folder.path },
      { history: "none" },
    );
    step(
      "copy",
      copied?.created[0]?.path === join(folder.path, "note.txt"),
      `${copied?.failures.length} failures`,
    );

    const dup = await runJob({ kind: "duplicate", sources: [note.path] }, { history: "none" });
    step("duplicate", dup?.created[0]?.name === "note copy.txt", dup?.created[0]?.name ?? "");

    const trashed = await runJob({ kind: "trash", paths: [note.path] }, { history: "none" });
    step("trash", trashed?.removed[0] === note.path && !!trashed.undo);
    const back = trashed?.undo
      ? await runJob({ kind: "undo", action: trashed.undo }, { history: "none" })
      : null;
    step("undo trash", back?.created[0]?.path === note.path, JSON.stringify(back?.failures ?? []));

    const renamed = await unwrap(commands.renamePath(note.path, "renamed.txt"));
    step("rename", renamed.name === "renamed.txt");

    const size = await new Promise<number>((resolve) => {
      const ch = new Channel<MeasureEvent>();
      ch.onmessage = (ev) => ev.type === "done" && resolve(ev.size.files);
      void commands.measure(crypto.randomUUID(), [dir], ch);
    });
    step("measure", size === 3, `${size} files`);

    // Preview pane: text head, and `asset://` only serving files explicitly allowed.
    const text = await unwrap(commands.previewText(renamed.path));
    step("preview text", !text.binary && !text.truncated && text.text === "");
    const icon = await unwrap(commands.dragPreview(dir));
    const png = (
      await runJob({ kind: "copy", sources: [icon], destDir: dir }, { history: "none", select: false })
    )?.created[0]?.path;
    if (png) {
      step("asset denied before allow", !(await loadsImage(convertFileSrc(png))));
      await unwrap(commands.allowPreview(png));
      step("asset served after allow", await loadsImage(convertFileSrc(png)));
      const folderDenied = await commands.allowPreview(dir);
      step("asset scope refuses folders", folderDenied.status === "error");
    } else {
      step("preview image copy", false);
    }

    // Syntax highlighting runs in a module worker under the app's CSP.
    const started = performance.now();
    const html = await highlight("x.ts", "const answer: number = 42;");
    step(
      "highlight worker",
      !!html?.includes("--shiki-dark") && html.includes("answer"),
      `${Math.round(performance.now() - started)}ms`,
    );
    const md = await import("@/features/preview/markdown-view").then(() => true).catch(() => false);
    step("markdown view chunk", md);

    // Terminal: a real login shell in the panel; its `cd` (OSC 7) drives a linked pane.
    const sub = await unwrap(commands.createItem(dir, "term dir", true));
    openTerminal(dir);
    const { activeId } = useTerminals.getState();
    // The view mounts on the next render and the shell needs a moment to print its prompt.
    const prompted = await waitFor(() => {
      const buf = terminalById(activeId ?? "")?.buffer.active;
      return !!buf && (buf.cursorX > 0 || buf.cursorY > 0);
    }, 15000);
    step("terminal opens with a prompt", prompted);
    if (activeId && prompted) {
      useTerminals.getState().update(activeId, { linked: true });
      // Typed before the prompt is up: the shell reads it once it's ready.
      await unwrap(commands.ptyWrite(activeId, `cd ${shellQuote(sub.path)}\r`));
      const cwd = () => useTerminals.getState().sessions.find((s) => s.id === activeId)?.cwd;
      step("shell reports cwd (OSC 7)", await waitFor(() => cwd() === sub.path, 15000), cwd());
      const followed = await waitFor(() => getActiveTab().path === sub.path, 3000);
      step("linked pane follows cd", followed, getActiveTab().path);
      navigateTo(dir);
      closeTerminal(activeId);
    }

    // Search: results stream into a tab like a folder and follow file operations.
    const target = await unwrap(commands.createItem(dir, "findme-ox.txt", false));
    const found = searchPath({
      scope: dir,
      query: "FINDME",
      mode: "name",
      caseSensitive: false,
      regex: false,
      includeHidden: false,
    });
    navigateTo(found);
    const results = () => useDirCache.getState().dirs[found]?.entries.map((e) => e.name) ?? [];
    const searched = await waitFor(() => useSearchInfo.getState().searches[found]?.outcome != null, 10000);
    step("name search", searched && results().join() === "findme-ox.txt", results().join());
    await runJob({ kind: "delete", paths: [target.path] }, { history: "none" });
    step("search results follow deletes", results().length === 0, results().join());
    navigateTo(dir);

    // Archives: compress a folder to zip, extract it next to the original ("arc 2").
    const arc = await unwrap(commands.createItem(dir, "arc", true));
    await unwrap(commands.createItem(arc.path, "inside.txt", false));
    const zipped = await runJob(
      { kind: "compress", sources: [arc.path], format: "zip" },
      { history: "none" },
    );
    const zipPath = zipped?.created[0]?.path ?? "";
    step("compress", zipPath.endsWith("/arc.zip") && zipped?.undo?.steps.length === 1, zipPath);
    const unzipped = await runJob({ kind: "extract", archives: [zipPath] }, { history: "none" });
    const outDir = unzipped?.created[0]?.path ?? "";
    const inside = await commands.statPath(join(outDir, "inside.txt"));
    step("extract", outDir.endsWith("/arc 2") && inside.status === "ok", outDir);

    // Tags: add and remove through the xattr.
    const tagged = await unwrap(
      commands.editTags([join(arc.path, "inside.txt")], [{ name: "Red", color: 6 }], []),
    );
    const untagged = await unwrap(commands.editTags([join(arc.path, "inside.txt")], [], ["Red"]));
    step(
      "tags",
      tagged[0]?.tags.some((t) => t.name === "Red" && t.color === 6) === true &&
        untagged[0]?.tags.length === 0,
    );

    // Batch rename with undo.
    const renamedBatch = await unwrap(
      commands.batchRename([
        { path: arc.path, newName: "arc-renamed" },
        { path: zipPath, newName: "arc-renamed.zip" },
      ]),
    );
    const undone = renamedBatch.undo
      ? await runJob({ kind: "undo", action: renamedBatch.undo }, { history: "none" })
      : null;
    const back2 = await commands.statPath(arc.path);
    step(
      "batch rename + undo",
      renamedBatch.entries.map((e) => e.name).join() === "arc-renamed,arc-renamed.zip" &&
        undone?.failures.length === 0 &&
        back2.status === "ok",
    );

    // Shortcuts: the menu bar is rebuilt at runtime; conflicts are refused.
    const custom = await commands.setShortcuts({ "file.rename": "Shift+CmdOrCtrl+E" });
    const clash = await commands.setShortcuts({ "file.rename": "CmdOrCtrl+D" });
    const restored = await commands.setShortcuts(useApp.getState().shortcuts);
    step("shortcuts", custom.status === "ok" && clash.status === "error" && restored.status === "ok");

    // The Settings window opens as its own window.
    await unwrap(commands.openSettings());
    const settings = await waitForAsync(() => WebviewWindow.getByLabel("settings"), 5000);
    step("settings window", !!settings);
    await settings?.close();

    // Language: the UI and the native menu switch to Turkish and back.
    const before = useApp.getState().language;
    useApp.getState().set({ language: "tr" });
    await sleep(300);
    const turkishUi = (document.body.textContent ?? "").includes("öğe");
    const items = await commands.menuItems();
    const menu = await commands.setMenuTitles(
      menuTitles("tr", [...MENU_LABELS, ...items.map((i) => i.title)]),
    );
    useApp.getState().set({ language: before });
    await commands.setMenuTitles(menuTitles(before, [...MENU_LABELS, ...items.map((i) => i.title)]));
    step("turkish ui + menu", turkishUi && menu.status === "ok");

    // Native Quick Look panel opens and closes through the controller hooks.
    await unwrap(commands.quickLook([renamed.path], 0, true));
    await sleep(800);
    const shown = await commands.quickLookVisible();
    await unwrap(commands.quickLookClose());
    await sleep(400);
    step("quick look panel", shown && !(await commands.quickLookVisible()), `shown=${shown}`);

    const gone = await runJob(
      {
        kind: "delete",
        paths: [
          folder.path,
          renamed.path,
          join(dir, "note copy.txt"),
          sub.path,
          arc.path,
          zipPath,
          outDir,
          ...(png ? [png] : []),
        ],
      },
      { history: "none" },
    );
    step("delete", gone?.removed.length === (png ? 8 : 7) && gone.failures.length === 0);
  } catch (err) {
    step("exception", false, String(err));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function loadsImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

async function waitForAsync<T>(get: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await get();
    if (v) return v;
    await sleep(100);
  }
  return null;
}
