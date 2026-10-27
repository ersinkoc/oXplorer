import { toast } from "sonner";
import { commands } from "@/bindings";
import { isFolderLike } from "@/lib/format";
import { CommandError, type FileEntry, toAppError, unwrap } from "@/lib/ipc";
import { normalizeUserInput, parent } from "@/lib/path";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { getActiveTab, type HistoryMode, type PaneId, useWorkspace } from "@/stores/workspace-store";

/** Points the active tab at `path`; the pane showing it loads the listing. */
export function navigateTo(
  path: string,
  opts: { pane?: PaneId; history?: HistoryMode; select?: string | null } = {},
): void {
  useWorkspace.getState().setPath(path, opts);
}

/** Lists `path` unless a listing is already in flight (two panes on one folder). */
export function ensureListed(path: string): void {
  const cache = useDirCache.getState();
  if (cache.dirs[path]?.status !== "loading") void cache.load(path);
}

export function goBack(): void {
  const { history } = getActiveTab();
  const target = history.stack[history.index - 1];
  if (target !== undefined) navigateTo(target, { history: "back" });
}

export function goForward(): void {
  const { history } = getActiveTab();
  const target = history.stack[history.index + 1];
  if (target !== undefined) navigateTo(target, { history: "forward" });
}

/** Enclosing folder; the folder we came from stays selected, like Finder. */
export function goUp(): void {
  const { path } = getActiveTab();
  const up = parent(path);
  if (up) navigateTo(up, { select: path });
}

export function reload(): void {
  void useDirCache.getState().load(getActiveTab().path);
}

/** Entries of the active tab's directory that are currently selected, in listing order. */
export function selectedEntries(pane?: PaneId): FileEntry[] {
  const tab = getActiveTab(pane);
  const entries = useDirCache.getState().dirs[tab.path]?.entries ?? [];
  return entries.filter((e) => tab.selection.paths.has(e.path));
}

/** Folders navigate in place; files and packages open in their default app. */
export async function openEntries(entries: readonly FileEntry[]): Promise<void> {
  const [first] = entries;
  if (entries.length === 1 && first && isFolderLike(first)) {
    navigateTo(first.path);
    return;
  }
  for (const e of entries) {
    if (isFolderLike(e)) continue;
    try {
      await unwrap(commands.openPath(e.path));
    } catch (err) {
      toast.error(err instanceof CommandError ? err.message : `Couldn’t open “${e.name}”.`);
    }
  }
}

/**
 * Opens paths handed to the app from outside: folders in new tabs, files in a
 * tab on their folder with the file selected.
 */
export async function openExternalPaths(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      const entry = await unwrap(commands.statPath(path));
      if (isFolderLike(entry) || entry.kind === "package") useWorkspace.getState().openTab(entry.path);
      else useWorkspace.getState().openTab(parent(entry.path) ?? "/", { select: entry.path });
    } catch (err) {
      toast.error(new CommandError(toAppError(err)).message);
    }
  }
}

/** Resolves typed input (⇧⌘G). Files navigate to their folder and get selected. */
export async function goToTypedPath(input: string): Promise<boolean> {
  const path = normalizeUserInput(input, useApp.getState().home);
  if (!path) {
    toast.error("Enter an absolute path, or one starting with ~.");
    return false;
  }
  try {
    const entry = await unwrap(commands.statPath(path));
    if (isFolderLike(entry) || entry.kind === "package") navigateTo(entry.path);
    else navigateTo(parent(entry.path) ?? "/", { select: entry.path });
    return true;
  } catch (err) {
    const e = toAppError(err);
    toast.error(e.kind === "notFound" ? `The folder “${path}” can’t be found.` : new CommandError(e).message);
    return false;
  }
}
