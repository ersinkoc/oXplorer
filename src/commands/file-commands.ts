import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { type ArchiveFormat, commands, type FinderTag } from "@/bindings";
import { applyFsChanges, recordUndo, runJob } from "@/commands/jobs";
import { transferSpec } from "@/commands/locations";
import { currentFolder, refuseArchiveMembers, selectedEntries, writableFolder } from "@/commands/navigation";
import { defineCommands } from "@/commands/registry";
import { focusedTerminal, pasteInto } from "@/features/terminal/terminal-registry";
import { askPassword } from "@/features/ui/password-prompt";
import { msg, t, tn } from "@/i18n";
import { CommandError, describeError, type FileEntry, unwrap } from "@/lib/ipc";
import { isConvertibleImage } from "@/lib/media";
import { basename, parent } from "@/lib/path";
import { isRemotePath, remoteDirOf } from "@/lib/remote-path";
import { isSearchPath } from "@/lib/search-path";
import { selectOne } from "@/lib/selection";
import { shellArgs } from "@/lib/shell";
import { firstPart } from "@/lib/split-parts";
import { copyText, cutText, deleteToLineStart, focusedTextField, pasteText, undoText } from "@/lib/text-edit";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { useHistory } from "@/stores/history-store";
import { getActiveTab, useWorkspace } from "@/stores/workspace-store";

function report(err: unknown, fallback: string): void {
  toast.error(err instanceof CommandError ? err.message : fallback);
}

function paths(entries: readonly FileEntry[]): string[] {
  return entries.map((e) => e.path);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((p) => s.has(p));
}

async function toPasteboard(cut: boolean): Promise<void> {
  const sel = paths(selectedEntries());
  if (sel.length === 0 || refuseArchiveMembers(sel)) return;
  try {
    await unwrap(commands.pasteboardWriteFiles(sel));
    useApp.getState().set({ clipboard: { paths: sel, cut } });
  } catch (err) {
    report(err, t("Couldn’t copy to the clipboard."));
  }
}

/** Pastes files from the general pasteboard (ours or Finder's) into the current folder. */
export async function pasteFiles(forceMove: boolean): Promise<void> {
  const sources = await commands.pasteboardReadFiles();
  if (sources.length === 0) return;
  const { clipboard } = useApp.getState();
  const wasCut = !!clipboard?.cut && sameSet(clipboard.paths, sources);
  const destDir = writableFolder();
  if (!destDir) return;
  if (isRemotePath(destDir)) {
    const spec = transferSpec(sources, destDir, "copy");
    if (spec) await runJob(spec);
    return;
  }
  if (forceMove || wasCut) {
    await runJob({ kind: "move", sources, destDir });
    if (wasCut) useApp.getState().set({ clipboard: null });
  } else {
    await runJob({ kind: "copy", sources, destDir });
  }
}

/** Creates an item and immediately starts renaming it, like Finder. */
export async function createItem(folder: boolean): Promise<void> {
  const dir = writableFolder();
  if (!dir) return;
  if (isRemotePath(dir)) return createRemoteFolder(dir, folder);
  try {
    const entry = await unwrap(commands.createItem(dir, folder ? "untitled folder" : "untitled.txt", folder));
    applyFsChanges([entry], []);
    recordUndo({
      label: folder ? msg("New Folder") : msg("New File"),
      steps: [{ kind: "trash", path: entry.path }],
    });
    useWorkspace.getState().setSelection(selectOne(entry.path));
    useApp.getState().set({ renaming: entry.path });
  } catch (err) {
    report(err, folder ? t("Couldn’t create the folder.") : t("Couldn’t create the file."));
  }
}

/** File → New Folder with Selection (⌃⌘N): moves the selection into a new folder, one undo step. */
async function newFolderWithSelection(): Promise<void> {
  const dir = writableFolder();
  const sources = paths(selectedEntries());
  if (!dir || sources.length === 0) return;
  if (isRemotePath(dir) || refuseRemote(sources)) return;
  if (sources.some((p) => parent(p) !== dir)) {
    toast(t("Select items in this folder to put them in a new folder."));
    return;
  }
  try {
    const folder = await unwrap(commands.createItem(dir, t("New Folder With Items"), true));
    applyFsChanges([folder], []);
    const moved = await runJob({ kind: "move", sources, destDir: folder.path }, { history: "none" });
    recordUndo({
      label: msg("New Folder with Selection"),
      steps: [...(moved?.undo?.steps ?? []), { kind: "trash", path: folder.path }],
    });
    useWorkspace.getState().setSelection(selectOne(folder.path));
    useApp.getState().set({ renaming: folder.path });
  } catch (err) {
    report(err, t("Couldn’t create the folder."));
  }
}

/** File → Make Alias (⌃⌘A): a symbolic link next to each selected item, undone in one step. */
async function makeAliases(): Promise<void> {
  const sources = paths(selectedEntries());
  if (sources.length === 0 || refuseArchiveMembers(sources) || refuseRemote(sources)) return;
  const made: FileEntry[] = [];
  try {
    for (const source of sources)
      made.push(await unwrap(commands.makeSymlink(source, t("{name} alias", { name: basename(source) }))));
  } catch (err) {
    report(err, t("Couldn’t make the alias."));
  }
  if (made.length === 0) return;
  applyFsChanges(made, []);
  recordUndo({
    label: msg("Make Alias"),
    steps: made.map((e) => ({ kind: "trash", path: e.path })),
  });
  const [first] = made;
  if (made.length === 1 && first) useWorkspace.getState().setSelection(selectOne(first.path));
}

/** On a server only folders can be created (files are uploaded). */
async function createRemoteFolder(dir: string, folder: boolean): Promise<void> {
  if (!folder) {
    toast(t("New files can’t be created on a server. Upload one instead."));
    return;
  }
  const taken = new Set(useDirCache.getState().dirs[dir]?.entries.map((e) => e.name) ?? []);
  const name = ["untitled folder", ...Array.from({ length: 50 }, (_, i) => `untitled folder ${i + 2}`)].find(
    (n) => !taken.has(n),
  );
  try {
    const path = await unwrap(commands.remoteCreateDir(dir, name ?? "untitled folder"));
    await useDirCache.getState().load(dir);
    useWorkspace.getState().setSelection(selectOne(path));
    useApp.getState().set({ renaming: path });
  } catch (err) {
    report(err, t("Couldn’t create the folder."));
  }
}

/** Server items: rename in place (no undo — servers keep no history). */
async function renameRemote(entry: FileEntry, name: string): Promise<boolean> {
  try {
    const renamed = await unwrap(commands.remoteRename(entry.path, name));
    await useDirCache.getState().load(remoteDirOf(entry.path));
    useWorkspace.getState().setSelection(selectOne(renamed));
    return true;
  } catch (err) {
    report(err, t("Couldn’t rename “{name}”.", { name: entry.name }));
    return false;
  }
}

/** Servers have no Trash: deleting there is permanent, so it's always confirmed. */
async function deleteRemote(sel: string[]): Promise<void> {
  const what =
    sel.length === 1 ? `“${basename(sel[0] ?? "")}”` : t("these {count} items", { count: sel.length });
  const ok = await ask(t("Delete {what} from the server? This can’t be undone.", { what }), {
    title: t("Delete from Server"),
    kind: "warning",
    okLabel: t("Delete"),
    cancelLabel: t("Cancel"),
  });
  if (!ok) return;
  try {
    await unwrap(commands.remoteDelete(sel));
  } catch (err) {
    report(err, t("Couldn’t delete the items."));
  }
  for (const dir of new Set(sel.map(remoteDirOf))) void useDirCache.getState().load(dir);
}

/** Things a server can't do here (duplicate, compress, tags, …). */
function refuseRemote(paths: readonly string[]): boolean {
  if (!paths.some(isRemotePath)) return false;
  toast(t("This isn’t available for items on a server."));
  return true;
}

/** Commits an inline rename. Returns false to keep the editor open. */
export async function commitRename(entry: FileEntry, newName: string): Promise<boolean> {
  const name = newName.trim();
  if (!name || name === entry.name) return true;
  if (isRemotePath(entry.path)) return renameRemote(entry, name);
  try {
    const renamed = await unwrap(commands.renamePath(entry.path, name));
    applyFsChanges([renamed], [entry.path]);
    recordUndo({ label: msg("Rename"), steps: [{ kind: "move", from: renamed.path, to: entry.path }] });
    const here = getActiveTab().path;
    if (isSearchPath(here) || parent(renamed.path) === here)
      useWorkspace.getState().setSelection(selectOne(renamed.path));
    return true;
  } catch (err) {
    report(err, t("Couldn’t rename “{name}”.", { name: entry.name }));
    return false;
  }
}

async function undoRedo(redo: boolean): Promise<void> {
  const h = useHistory.getState();
  const stack = redo ? h.redo : h.undo;
  const action = stack.at(-1);
  if (!action) return;
  h.set(redo ? { redo: stack.slice(0, -1) } : { undo: stack.slice(0, -1) });
  const outcome = await runJob({ kind: "undo", action }, { history: redo ? "redo" : "undo" });
  if (outcome && outcome.failures.length === 0)
    toast(
      redo
        ? t("Redo {action}", { action: t(action.label) })
        : t("Undo {action}", { action: t(action.label) }),
    );
}

/**
 * Edit-menu actions while a terminal has focus: copy the selection, paste text
 * (or the paths of copied files), select all; ⌘⌫ clears the line (⌃U).
 */
async function terminalEdit(action: "copy" | "paste" | "selectAll" | "clearLine"): Promise<boolean> {
  const focused = focusedTerminal();
  if (!focused) return false;
  const { id, term } = focused;
  switch (action) {
    case "copy": {
      const text = term.getSelection();
      if (text) await writeText(text);
      break;
    }
    case "paste": {
      const text = await readText().catch(() => "");
      if (text) pasteInto(id, text);
      else {
        const files = await commands.pasteboardReadFiles();
        if (files.length > 0) pasteInto(id, shellArgs(files));
      }
      break;
    }
    case "selectAll":
      term.selectAll();
      break;
    case "clearLine":
      void commands.ptyWrite(id, "\x15");
      break;
  }
  return true;
}

export const ARCHIVE_FORMATS: readonly [ArchiveFormat, string][] = [
  ["zip", "zip"],
  ["tarGz", "tar.gz"],
  ["tarZst", "tar.zst"],
];

/** Command titles, translated where they're shown. */
const COMPRESS_TITLES: Record<ArchiveFormat, string> = {
  zip: msg("Compress (zip)"),
  tarGz: msg("Compress (tar.gz)"),
  tarZst: msg("Compress (tar.zst)"),
};

const ARCHIVE_SUFFIXES = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.zst", ".tzst"];

/** Archives OXplorer can extract (the same list as `jobs/archive.rs`). */
export function isArchive(entry: FileEntry): boolean {
  const name = entry.name.toLowerCase();
  return entry.kind === "file" && ARCHIVE_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length);
}

/** Compresses the selection next to itself (Finder: one item → "name.zip", several → "Archive.zip"). */
async function compress(format: ArchiveFormat, withPassword = false): Promise<void> {
  const sel = paths(selectedEntries());
  if (sel.length === 0 || refuseArchiveMembers(sel) || refuseRemote(sel)) return;
  const folders = new Set(sel.map((p) => parent(p)));
  if (folders.size > 1) {
    toast(t("Items from different folders can’t go into one archive."));
    return;
  }
  const password = withPassword
    ? await askPassword({
        title: t("Zip with Password"),
        message: t(
          "The files are encrypted with AES-256. Finder’s Archive Utility can’t open such archives; OXplorer, Keka, The Unarchiver and 7-Zip can.",
        ),
        confirm: true,
      })
    : null;
  if (withPassword && !password) return;
  await runJob({ kind: "compress", sources: sel, format, password });
}

/** Empty Trash: asks first, like Finder; the items can't be brought back. */
async function emptyTrash(): Promise<void> {
  const count = await commands.trashCount();
  if (count.status === "error") {
    toast.error(t("Couldn’t read the Trash: {reason}", { reason: describeError(count.error) }));
    return;
  }
  if (count.data === 0) {
    toast(t("The Trash is empty."));
    return;
  }
  const ok = await ask(
    tn(
      count.data,
      "Are you sure you want to permanently erase the item in the Trash?",
      "Are you sure you want to permanently erase the {count} items in the Trash?",
    ),
    {
      title: t("Empty Trash"),
      kind: "warning",
      okLabel: t("Empty Trash"),
      cancelLabel: t("Cancel"),
    },
  );
  if (ok) await runJob({ kind: "emptyTrash" }, { select: false });
}

/** Combine Files: joins the set the selected part belongs to, next to the parts. */
async function combineParts(): Promise<void> {
  const sel = paths(selectedEntries());
  const first = sel.length === 1 && sel[0] ? firstPart(sel[0]) : null;
  if (!first) {
    toast(t("Select the first part of a split file (a name ending in .001)."));
    return;
  }
  if (refuseArchiveMembers([first]) || refuseRemote([first])) return;
  await runJob({ kind: "join", first, destDir: parent(first) ?? "/" });
}

/** Extract Here: encrypted zips ask for their password first (one for all of them). */
async function extractSelected(): Promise<void> {
  const archives = selectedEntries()
    .filter(isArchive)
    .map((e) => e.path);
  if (archives.length === 0) return;
  const flags = await Promise.all(archives.map((a) => commands.archiveEncrypted(a)));
  const locked = archives.filter((_, i) => {
    const r = flags[i];
    return r?.status === "ok" && r.data;
  });
  const plain = archives.filter((a) => !locked.includes(a));
  if (plain.length > 0) await runJob({ kind: "extract", archives: plain });
  if (locked.length === 0) return;
  const password = await askPassword({
    title:
      locked.length === 1
        ? t("“{name}” is encrypted", { name: basename(locked[0] ?? "") })
        : t("Encrypted archives"),
    message: t("Enter the password to extract it."),
  });
  if (password) await runJob({ kind: "extract", archives: locked, password });
}

/** Adds a tag to every item, or removes it when they all have it already. */
export async function toggleTag(entries: readonly FileEntry[], tag: FinderTag): Promise<void> {
  if (refuseArchiveMembers(paths(entries)) || refuseRemote(paths(entries))) return;
  const all = entries.every((e) => e.tags.some((t) => t.name === tag.name));
  try {
    const out = await unwrap(commands.editTags(paths(entries), all ? [] : [tag], all ? [tag.name] : []));
    applyFsChanges(out.entries, []);
    recordUndo(out.undo);
  } catch (err) {
    report(err, t("Couldn’t change the tags."));
  }
}

export function registerFileCommands(): void {
  defineCommands([
    {
      id: "edit.copy",
      title: "Copy",
      run: async () => {
        if (await terminalEdit("copy")) return;
        const field = focusedTextField();
        return field ? copyText(field) : toPasteboard(false);
      },
    },
    {
      id: "edit.cut",
      title: "Cut",
      run: async () => {
        // Terminal output can't be cut; it's copied like in Terminal.app.
        if (await terminalEdit("copy")) return;
        const field = focusedTextField();
        return field ? cutText(field) : toPasteboard(true);
      },
    },
    {
      id: "edit.paste",
      title: "Paste",
      run: async () => {
        if (await terminalEdit("paste")) return;
        const field = focusedTextField();
        return field ? pasteText(field) : pasteFiles(false);
      },
    },
    { id: "edit.pasteMove", title: "Move Item Here", run: () => pasteFiles(true) },
    {
      id: "edit.undo",
      title: "Undo",
      run: () => {
        if (focusedTerminal()) return;
        return focusedTextField() ? undoText(false) : undoRedo(false);
      },
    },
    {
      id: "edit.redo",
      title: "Redo",
      run: () => {
        if (focusedTerminal()) return;
        return focusedTextField() ? undoText(true) : undoRedo(true);
      },
    },

    { id: "file.newFolder", title: "New Folder", run: () => createItem(true) },
    { id: "file.newFile", title: "New File", run: () => createItem(false) },
    { id: "file.newFolderWithSelection", title: "New Folder with Selection", run: newFolderWithSelection },
    {
      id: "file.rename",
      title: "Rename",
      run: () => {
        if (refuseArchiveMembers(paths(selectedEntries()))) return;
        const sel = selectedEntries();
        const [only] = sel;
        if (sel.length === 1 && only) useApp.getState().set({ renaming: only.path });
        else if (sel.length > 1 && refuseRemote(paths(sel))) return;
        else if (sel.length > 1) useApp.getState().set({ batchRename: sel });
      },
    },
    { id: "file.makeAlias", title: "Make Alias", run: makeAliases },
    {
      id: "file.split",
      title: "Split File…",
      run: () => {
        const sel = selectedEntries();
        const file = sel[0];
        if (sel.length !== 1 || !file || file.kind !== "file") {
          toast(t("Select one file to split."));
          return;
        }
        if (refuseArchiveMembers([file.path]) || refuseRemote([file.path])) return;
        useApp.getState().set({ splitFile: { path: file.path, size: file.size } });
      },
    },
    { id: "file.combine", title: "Combine Files", run: combineParts },
    {
      id: "file.verifyChecksums",
      title: "Verify Checksums…",
      run: () => {
        const sel = selectedEntries();
        const list = sel[0];
        if (sel.length !== 1 || !list || list.kind !== "file") {
          toast(t("Select a checksum list (such as SHA256SUMS or a .sha256 file)."));
          return;
        }
        if (refuseArchiveMembers([list.path]) || refuseRemote([list.path])) return;
        useApp.getState().set({ verifyPath: list.path });
      },
    },
    {
      id: "file.convertImage",
      title: "Convert Image…",
      run: () => {
        const images = selectedEntries().filter(isConvertibleImage);
        const sources = paths(images);
        if (refuseArchiveMembers(sources) || refuseRemote(sources)) return;
        if (sources.length === 0) {
          toast(t("Select one or more pictures first."));
          return;
        }
        useApp.getState().set({ convertPaths: sources });
      },
    },
    {
      id: "file.duplicate",
      title: "Duplicate",
      run: async () => {
        if (refuseArchiveMembers(paths(selectedEntries())) || refuseRemote(paths(selectedEntries()))) return;
        const sources = paths(selectedEntries());
        if (sources.length > 0) await runJob({ kind: "duplicate", sources });
      },
    },
    {
      id: "file.trash",
      title: "Move to Trash",
      run: async () => {
        if (await terminalEdit("clearLine")) return;
        const field = focusedTextField();
        if (field) return deleteToLineStart(field);
        const sel = paths(selectedEntries());
        if (refuseArchiveMembers(sel)) return;
        if (sel.some(isRemotePath)) return deleteRemote(sel);
        if (sel.length > 0) await runJob({ kind: "trash", paths: sel }, { select: false });
      },
    },
    {
      id: "file.delete",
      title: "Delete Immediately…",
      run: async () => {
        if (refuseArchiveMembers(paths(selectedEntries()))) return;
        const sel = paths(selectedEntries());
        if (sel.some(isRemotePath)) return deleteRemote(sel);
        if (sel.length === 0) return;
        const question =
          sel.length === 1
            ? t("Are you sure you want to delete “{name}” immediately?", { name: basename(sel[0] ?? "") })
            : t("Are you sure you want to delete these {count} items immediately?", {
                count: sel.length.toLocaleString(),
              });
        const ok = await ask(question, {
          title: t("Delete Immediately"),
          kind: "warning",
          okLabel: t("Delete"),
          cancelLabel: t("Cancel"),
        });
        if (ok) await runJob({ kind: "delete", paths: sel }, { select: false });
      },
    },
    { id: "file.emptyTrash", title: "Empty Trash…", run: emptyTrash },
    ...ARCHIVE_FORMATS.map(([format]) => ({
      id: `file.compress.${format}`,
      title: COMPRESS_TITLES[format],
      run: () => compress(format),
    })),
    { id: "file.compress.zipPassword", title: "Zip with Password…", run: () => compress("zip", true) },
    { id: "file.extract", title: "Extract Here", run: extractSelected },
    {
      id: "file.getInfo",
      title: "Get Info",
      run: () => {
        const sel = paths(selectedEntries());
        useApp.getState().set({ infoPaths: sel.length > 0 ? sel : [currentFolder()] });
      },
    },
  ]);
}
