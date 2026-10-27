import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { type ArchiveFormat, commands, type FinderTag } from "@/bindings";
import { applyFsChanges, recordUndo, runJob } from "@/commands/jobs";
import { currentFolder, selectedEntries, writableFolder } from "@/commands/navigation";
import { defineCommands } from "@/commands/registry";
import { focusedTerminal, pasteInto } from "@/features/terminal/terminal-registry";
import { CommandError, type FileEntry, unwrap } from "@/lib/ipc";
import { basename, parent } from "@/lib/path";
import { isSearchPath } from "@/lib/search-path";
import { selectOne } from "@/lib/selection";
import { shellArgs } from "@/lib/shell";
import { copyText, cutText, deleteToLineStart, focusedTextField, pasteText, undoText } from "@/lib/text-edit";
import { useApp } from "@/stores/app-store";
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
  if (sel.length === 0) return;
  try {
    await unwrap(commands.pasteboardWriteFiles(sel));
    useApp.getState().set({ clipboard: { paths: sel, cut } });
  } catch (err) {
    report(err, "Couldn’t copy to the clipboard.");
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
  try {
    const entry = await unwrap(commands.createItem(dir, folder ? "untitled folder" : "untitled.txt", folder));
    applyFsChanges([entry], []);
    recordUndo({ label: folder ? "New Folder" : "New File", steps: [{ kind: "trash", path: entry.path }] });
    useWorkspace.getState().setSelection(selectOne(entry.path));
    useApp.getState().set({ renaming: entry.path });
  } catch (err) {
    report(err, folder ? "Couldn’t create the folder." : "Couldn’t create the file.");
  }
}

/** Commits an inline rename. Returns false to keep the editor open. */
export async function commitRename(entry: FileEntry, newName: string): Promise<boolean> {
  const name = newName.trim();
  if (!name || name === entry.name) return true;
  try {
    const renamed = await unwrap(commands.renamePath(entry.path, name));
    applyFsChanges([renamed], [entry.path]);
    recordUndo({ label: "Rename", steps: [{ kind: "move", from: renamed.path, to: entry.path }] });
    const here = getActiveTab().path;
    if (isSearchPath(here) || parent(renamed.path) === here)
      useWorkspace.getState().setSelection(selectOne(renamed.path));
    return true;
  } catch (err) {
    report(err, `Couldn’t rename “${entry.name}”.`);
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
  if (outcome && outcome.failures.length === 0) toast(`${redo ? "Redo" : "Undo"} ${action.label}`);
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

const ARCHIVE_SUFFIXES = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.zst", ".tzst"];

/** Archives OXplorer can extract (the same list as `jobs/archive.rs`). */
export function isArchive(entry: FileEntry): boolean {
  const name = entry.name.toLowerCase();
  return entry.kind === "file" && ARCHIVE_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length);
}

/** Compresses the selection next to itself (Finder: one item → "name.zip", several → "Archive.zip"). */
async function compress(format: ArchiveFormat): Promise<void> {
  const sel = paths(selectedEntries());
  if (sel.length === 0) return;
  const folders = new Set(sel.map((p) => parent(p)));
  if (folders.size > 1) {
    toast("Items from different folders can’t go into one archive.");
    return;
  }
  await runJob({ kind: "compress", sources: sel, format });
}

/** Adds a tag to every item, or removes it when they all have it already. */
export async function toggleTag(entries: readonly FileEntry[], tag: FinderTag): Promise<void> {
  const all = entries.every((e) => e.tags.some((t) => t.name === tag.name));
  try {
    const updated = await unwrap(commands.editTags(paths(entries), all ? [] : [tag], all ? [tag.name] : []));
    applyFsChanges(updated, []);
  } catch (err) {
    report(err, "Couldn’t change the tags.");
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
    {
      id: "file.rename",
      title: "Rename",
      run: () => {
        const sel = selectedEntries();
        const [only] = sel;
        if (sel.length === 1 && only) useApp.getState().set({ renaming: only.path });
        else if (sel.length > 1) useApp.getState().set({ batchRename: sel });
      },
    },
    {
      id: "file.duplicate",
      title: "Duplicate",
      run: async () => {
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
        if (sel.length > 0) await runJob({ kind: "trash", paths: sel }, { select: false });
      },
    },
    {
      id: "file.delete",
      title: "Delete Immediately…",
      run: async () => {
        const sel = paths(selectedEntries());
        if (sel.length === 0) return;
        const what = sel.length === 1 ? `“${basename(sel[0] ?? "")}”` : `these ${sel.length} items`;
        const ok = await ask(`Are you sure you want to delete ${what} immediately?`, {
          title: "Delete Immediately",
          kind: "warning",
          okLabel: "Delete",
          cancelLabel: "Cancel",
        });
        if (ok) await runJob({ kind: "delete", paths: sel }, { select: false });
      },
    },
    ...ARCHIVE_FORMATS.map(([format, label]) => ({
      id: `file.compress.${format}`,
      title: `Compress (${label})`,
      run: () => compress(format),
    })),
    {
      id: "file.extract",
      title: "Extract Here",
      run: async () => {
        const archives = selectedEntries()
          .filter(isArchive)
          .map((e) => e.path);
        if (archives.length > 0) await runJob({ kind: "extract", archives });
      },
    },
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
