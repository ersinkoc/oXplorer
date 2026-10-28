import { Channel, convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { info, error as logError } from "@tauri-apps/plugin-log";
import {
  commands,
  type MeasureEvent,
  type UsageEvent_Deserialize,
  type UsageEvent_Serialize,
  type UsageNode,
} from "@/bindings";
import { resolveConflict, runJob } from "@/commands/jobs";
import { goHistory, goUp, navigateTo } from "@/commands/navigation";
import { runCommand } from "@/commands/registry";
import { closeTerminal, openTerminal } from "@/commands/terminal-commands";
import { terminalById } from "@/features/terminal/terminal-registry";
import { menuTitles } from "@/i18n";
import { MENU_LABELS } from "@/i18n/menu-labels";
import { archivePath } from "@/lib/archive-path";
import { highlight } from "@/lib/highlight";
import { unwrap } from "@/lib/ipc";
import { join, parent } from "@/lib/path";
import { remotePath } from "@/lib/remote-path";
import { searchPath } from "@/lib/search-path";
import { selectOne } from "@/lib/selection";
import { shellQuote } from "@/lib/shell";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { useHistory } from "@/stores/history-store";
import { useJobs } from "@/stores/jobs-store";
import { useSearchInfo } from "@/stores/search-store";
import { useTerminals } from "@/stores/terminal-store";
import { getActiveTab, useWorkspace } from "@/stores/workspace-store";

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

    // Browsing the zip like a folder: list, copy a member out, open one, go back up.
    navigateTo(archivePath(zipPath));
    const inZip = archivePath(zipPath, "arc");
    await waitFor(() => useDirCache.getState().dirs[archivePath(zipPath)]?.status === "ready", 5000);
    navigateTo(inZip);
    await waitFor(() => useDirCache.getState().dirs[inZip]?.status === "ready", 5000);
    const members = useDirCache.getState().dirs[inZip]?.entries.map((e) => e.name) ?? [];
    const outOfZip = await unwrap(commands.createItem(dir, "from-zip", true));
    const copied2 = await runJob(
      { kind: "extractMembers", sources: [archivePath(zipPath, "arc/inside.txt")], destDir: outOfZip.path },
      { history: "none", select: false },
    );
    const opened = await commands.archiveOpenMember(archivePath(zipPath, "arc/inside.txt"));
    runCommand("nav.up");
    runCommand("nav.up");
    const backIn = getActiveTab();
    step(
      "browse archive",
      members.join() === "inside.txt" &&
        copied2?.created[0]?.path === join(outOfZip.path, "inside.txt") &&
        opened.status === "ok" &&
        backIn.path === dir &&
        backIn.selection.paths.has(zipPath),
      `${members.join()} | ${backIn.path}`,
    );

    // A "server" (a local folder through OpenDAL): list, upload, download, rename, delete.
    const serverRoot = await unwrap(commands.createItem(dir, "fake-server", true));
    await unwrap(commands.createItem(serverRoot.path, "remote.txt", false));
    await unwrap(commands.remoteRegisterTestFolder("selftest", serverRoot.path));
    const top = remotePath("selftest");
    navigateTo(top);
    await waitFor(() => useDirCache.getState().dirs[top]?.status === "ready", 5000);
    const listed =
      useDirCache
        .getState()
        .dirs[top]?.entries.map((e) => e.name)
        .join() ?? "";
    const uploadSrc = await unwrap(commands.createItem(dir, "to-upload.txt", false));
    await runJob(
      { kind: "upload", sources: [uploadSrc.path], destDir: top },
      { history: "none", select: false },
    );
    const afterUpload = await unwrap(commands.remoteList(top));
    const downloadDest = await unwrap(commands.createItem(dir, "downloads", true));
    const down = await runJob(
      { kind: "download", sources: [remotePath("selftest", "remote.txt")], destDir: downloadDest.path },
      { history: "none", select: false },
    );
    const renamedRemote = await unwrap(
      commands.remoteRename(remotePath("selftest", "to-upload.txt"), "up.txt"),
    );
    await unwrap(commands.remoteDelete([renamedRemote]));
    const finalList = await unwrap(commands.remoteList(top));
    navigateTo(dir);
    step(
      "remote folder",
      listed === "remote.txt" &&
        afterUpload.some((e) => e.name === "to-upload.txt") &&
        down?.created[0]?.path === join(downloadDest.path, "remote.txt") &&
        finalList.map((e) => e.name).join() === "remote.txt",
      `${listed} | ${finalList.map((e) => e.name).join()}`,
    );

    // Tags: add and remove through the xattr, and undo the removal.
    const tagged = await unwrap(
      commands.editTags([join(arc.path, "inside.txt")], [{ name: "Red", color: 6 }], []),
    );
    const untagged = await unwrap(commands.editTags([join(arc.path, "inside.txt")], [], ["Red"]));
    const retagged = await runJob({ kind: "undo", action: untagged.undo }, { history: "none" });
    step(
      "tags + undo",
      tagged.entries[0]?.tags.some((t) => t.name === "Red" && t.color === 6) === true &&
        untagged.entries[0]?.tags.length === 0 &&
        retagged?.created[0]?.tags.some((t) => t.name === "Red") === true,
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

    // Compare panes: only the item missing on the right is selected as a difference.
    const cmpA = await unwrap(commands.createItem(dir, "cmp-a", true));
    const cmpB = await unwrap(commands.createItem(dir, "cmp-b", true));
    await unwrap(commands.createItem(cmpA.path, "only-left.txt", false));
    const ws = useWorkspace.getState();
    ws.setDualPane(true);
    navigateTo(cmpA.path, { pane: "left" });
    navigateTo(cmpB.path, { pane: "right" });
    await waitFor(
      () =>
        useDirCache.getState().dirs[cmpA.path]?.status === "ready" &&
        useDirCache.getState().dirs[cmpB.path]?.status === "ready",
      5000,
    );
    runCommand("pane.compare");
    useWorkspace.getState().setActivePane("left");
    runCommand("pane.selectDifferences");
    const picked = [...getActiveTab("left").selection.paths];
    step(
      "compare panes",
      picked.length === 1 && picked[0] === join(cmpA.path, "only-left.txt"),
      picked.join(),
    );
    runCommand("pane.compare");
    useWorkspace.getState().setDualPane(false);
    navigateTo(dir, { pane: "left" });

    // Disk usage: the scan counts the files, and the window draws a treemap.
    const usage = await new Promise<UsageNode | null>((resolve) => {
      const ch = new Channel<UsageEvent_Deserialize>();
      ch.onmessage = (raw) => {
        const ev = raw as UsageEvent_Serialize;
        if (ev.type === "done") resolve(ev.root);
      };
      void commands.diskUsage(crypto.randomUUID(), dir, ch);
    });
    useApp.getState().set({ diskUsagePath: dir });
    const drawn = await waitFor(() => !!document.querySelector("svg[role='img'] rect"), 5000);
    useApp.getState().set({ diskUsagePath: null });
    step("disk usage", !!usage && usage.files > 0 && drawn, `${usage?.files} files, drawn=${drawn}`);

    // Git: a folder outside any repository has no status (and doesn't fail).
    const git = await commands.gitStatus(dir);
    step("git status outside a repo", git.status === "ok" && git.data === null);

    // Native Quick Look panel opens and closes through the controller hooks.
    await unwrap(commands.quickLook([renamed.path], 0, true));
    await sleep(800);
    const shown = await commands.quickLookVisible();
    await unwrap(commands.quickLookClose());
    await sleep(400);
    step("quick look panel", shown && !(await commands.quickLookVisible()), `shown=${shown}`);

    // New Folder with Selection, then undo puts everything back.
    const nfDir = await unwrap(commands.createItem(folder.path, "nf", true));
    const nf1 = await unwrap(commands.createItem(nfDir.path, "one.txt", false));
    const nf2 = await unwrap(commands.createItem(nfDir.path, "two.txt", false));
    useWorkspace.getState().setActivePane("left");
    navigateTo(nfDir.path, { pane: "left" });
    void useDirCache.getState().load(nfDir.path);
    await waitFor(() => (useDirCache.getState().dirs[nfDir.path]?.entries.length ?? 0) === 2, 3000);
    useWorkspace
      .getState()
      .setSelection({ paths: new Set([nf1.path, nf2.path]), anchor: null, focus: null }, "left");
    runCommand("file.newFolderWithSelection");
    const groupedPath = join(join(nfDir.path, "New Folder With Items"), "one.txt");
    const grouped = await waitForAsync(async () => {
      const r = await commands.statPath(groupedPath);
      return r.status === "ok" ? r.data : null;
    }, 5000);
    useApp.getState().set({ renaming: null });
    // Let the rename field go away, or ⌘Z would undo its text instead.
    await sleep(300);
    // Undo the whole step: items back, the folder in the Trash.
    runCommand("edit.undo");
    const ungrouped = await waitForAsync(async () => {
      const [one, box] = await Promise.all([
        commands.statPath(nf1.path),
        commands.statPath(join(nfDir.path, "New Folder With Items")),
      ]);
      return one.status === "ok" && box.status === "error" ? true : null;
    }, 5000);
    step(
      "new folder with selection + undo",
      !!grouped && !!ungrouped,
      `grouped=${!!grouped} undone=${!!ungrouped}`,
    );

    // Make Alias: a symlink next to the item, gone again after undo.
    useWorkspace.getState().setSelection(selectOne(nf1.path), "left");
    runCommand("file.makeAlias");
    const aliasPath = join(nfDir.path, "one.txt alias");
    const alias = await waitForAsync(async () => {
      const r = await commands.statPath(aliasPath);
      return r.status === "ok" ? r.data : null;
    }, 5000);
    // The link exists before the undo step is recorded.
    await waitFor(() => useHistory.getState().undo.at(-1)?.label === "Make Alias", 3000);
    runCommand("edit.undo");
    const unaliased = await waitForAsync(
      async () => ((await commands.statPath(aliasPath)).status === "error" ? true : null),
      5000,
    );
    step(
      "make alias + undo",
      alias?.kind === "symlink" && alias.symlink?.target === nf1.path && !!unaliased,
      `kind=${alias?.kind} target=${alias?.symlink?.target} undone=${!!unaliased}`,
    );

    // Folder clash: Merge puts the incoming items into the existing folder.
    const mergeSrc = await unwrap(commands.createItem(folder.path, "merge src", true));
    const mergeDest = await unwrap(commands.createItem(folder.path, "merge dest", true));
    const incoming = await unwrap(commands.createItem(mergeSrc.path, "box", true));
    await unwrap(commands.createItem(incoming.path, "new.txt", false));
    const existing = await unwrap(commands.createItem(mergeDest.path, "box", true));
    await unwrap(commands.createItem(existing.path, "old.txt", false));
    const merging = runJob({ kind: "copy", sources: [incoming.path], destDir: mergeDest.path });
    const paused = await waitForAsync(
      async () => Object.values(useJobs.getState().jobs).find((j) => j.conflict) ?? null,
      5000,
    );
    if (paused) resolveConflict(paused.id, { choice: "merge", applyToAll: false });
    await merging;
    const merged = await Promise.all([
      commands.statPath(join(existing.path, "new.txt")),
      commands.statPath(join(existing.path, "old.txt")),
    ]);
    step(
      "merge folders",
      !!paused && merged.every((r) => r.status === "ok"),
      `paused=${!!paused} ${merged.map((r) => r.status).join(",")}`,
    );

    // Get Info → Permissions.
    const chmod = await commands.setPermissions(nf1.path, 0o600);
    step(
      "set permissions",
      chmod.status === "ok" && (chmod.data.mode & 0o777) === 0o600,
      chmod.status === "ok" ? chmod.data.mode.toString(8) : JSON.stringify(chmod.error),
    );

    // SHA-256 (Get Info) of an empty file.
    const sum = await commands.checksum(crypto.randomUUID(), nf1.path);
    step(
      "checksum",
      sum.status === "ok" && sum.data === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      sum.status === "ok" ? sum.data : JSON.stringify(sum.error),
    );

    const syncRoot = parent(folder.path) ?? "/";
    // Back / Forward history menu: jump several places at once.
    useWorkspace.getState().setActivePane("left");
    navigateTo(nfDir.path, { pane: "left" });
    navigateTo(folder.path, { pane: "left" });
    navigateTo(syncRoot, { pane: "left" });
    goHistory(-2);
    const jumpedBack = getActiveTab("left").path;
    goHistory(2);
    step(
      "history jump",
      jumpedBack === nfDir.path && getActiveTab("left").path === syncRoot,
      `back=${jumpedBack} forward=${getActiveTab("left").path}`,
    );

    // Synchronized browsing: the right pane follows the left into "sub" and back up.
    const syncA = await unwrap(commands.createItem(folder.path, "sync a", true));
    const syncB = await unwrap(commands.createItem(folder.path, "sync b", true));
    await unwrap(commands.createItem(syncA.path, "sub", true));
    await unwrap(commands.createItem(syncB.path, "sub", true));
    const wsBefore = useWorkspace.getState();
    wsBefore.setDualPane(true);
    navigateTo(syncA.path, { pane: "left" });
    navigateTo(syncB.path, { pane: "right" });
    void useDirCache.getState().load(syncB.path);
    await waitFor(
      () => !!useDirCache.getState().dirs[syncB.path]?.entries.some((e) => e.name === "sub"),
      3000,
    );
    useWorkspace.getState().setActivePane("left");
    useApp.getState().set({ syncBrowse: true });
    navigateTo(join(syncA.path, "sub"));
    const followedIn = getActiveTab("right").path === join(syncB.path, "sub");
    goUp();
    const followedUp = getActiveTab("right").path === syncB.path;
    useApp.getState().set({ syncBrowse: false });
    step("synchronized browsing", followedIn && followedUp, `in=${followedIn} up=${followedUp}`);

    const completed = await unwrap(commands.completePath(folder.path, "SY"));
    step("path completion", completed.join("|") === "sync a|sync b", completed.join("|"));

    await unwrap(commands.openWindow(folder.path));
    const win = await waitForAsync(() => WebviewWindow.getByLabel("window-2"), 5000);
    await sleep(2500);
    await win?.close();
    const closed = await waitFor(() => true, 1000).then(() => WebviewWindow.getByLabel("window-2"));
    step("new window", !!win && !closed);

    const gone = await runJob(
      {
        kind: "delete",
        paths: [
          folder.path,
          renamed.path,
          join(dir, "note copy.txt"),
          sub.path,
          arc.path,
          cmpA.path,
          outOfZip.path,
          serverRoot.path,
          uploadSrc.path,
          downloadDest.path,
          cmpB.path,
          zipPath,
          outDir,
          ...(png ? [png] : []),
        ],
      },
      { history: "none" },
    );
    step("delete", gone?.removed.length === (png ? 14 : 13) && gone.failures.length === 0);
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
