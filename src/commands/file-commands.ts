import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { applyFsChanges, recordUndo, runJob } from "@/commands/jobs";
import { selectedEntries } from "@/commands/navigation";
import { defineCommands } from "@/commands/registry";
import { CommandError, type FileEntry, unwrap } from "@/lib/ipc";
import { basename, parent } from "@/lib/path";
import { selectOne } from "@/lib/selection";
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
  const destDir = getActiveTab().path;
  if (forceMove || wasCut) {
    await runJob({ kind: "move", sources, destDir });
    if (wasCut) useApp.getState().set({ clipboard: null });
  } else {
    await runJob({ kind: "copy", sources, destDir });
  }
}

/** Creates an item and immediately starts renaming it, like Finder. */
export async function createItem(folder: boolean): Promise<void> {
  const dir = getActiveTab().path;
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
    if (parent(renamed.path) === getActiveTab().path)
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

export function registerFileCommands(): void {
  defineCommands([
    {
      id: "edit.copy",
      title: "Copy",
      run: () => {
        const field = focusedTextField();
        return field ? copyText(field) : toPasteboard(false);
      },
    },
    {
      id: "edit.cut",
      title: "Cut",
      run: () => {
        const field = focusedTextField();
        return field ? cutText(field) : toPasteboard(true);
      },
    },
    {
      id: "edit.paste",
      title: "Paste",
      run: () => {
        const field = focusedTextField();
        return field ? pasteText(field) : pasteFiles(false);
      },
    },
    { id: "edit.pasteMove", title: "Move Item Here", run: () => pasteFiles(true) },
    {
      id: "edit.undo",
      title: "Undo",
      run: () => (focusedTextField() ? undoText(false) : undoRedo(false)),
    },
    {
      id: "edit.redo",
      title: "Redo",
      run: () => (focusedTextField() ? undoText(true) : undoRedo(true)),
    },

    { id: "file.newFolder", title: "New Folder", run: () => createItem(true) },
    { id: "file.newFile", title: "New File", run: () => createItem(false) },
    {
      id: "file.rename",
      title: "Rename",
      run: () => {
        const [only, ...rest] = selectedEntries();
        if (only && rest.length === 0) useApp.getState().set({ renaming: only.path });
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
    {
      id: "file.getInfo",
      title: "Get Info",
      run: () => {
        const sel = paths(selectedEntries());
        useApp.getState().set({ infoPaths: sel.length > 0 ? sel : [getActiveTab().path] });
      },
    },
  ]);
}
