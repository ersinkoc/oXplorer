import { toast } from "sonner";
import { commands } from "@/bindings";
import { materialize } from "@/commands/locations";
import { t } from "@/i18n";
import { archiveParent, archivePath, isArchiveName, isArchivePath } from "@/lib/archive-path";
import { isFolderLike } from "@/lib/format";
import { CommandError, type FileEntry, toAppError, unwrap } from "@/lib/ipc";
import { mirrorMove, normalizeUserInput, parent } from "@/lib/path";
import { isRemotePath, remoteParent } from "@/lib/remote-path";
import { isSearchPath, isVirtualPath, parseSearchPath, realFolder } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { clearFolderSizes } from "@/stores/folder-size-store";
import { getActiveTab, type HistoryMode, type PaneId, useWorkspace } from "@/stores/workspace-store";

/** Points the active tab at `path`; the pane showing it loads the listing. */
export function navigateTo(
  path: string,
  opts: { pane?: PaneId; history?: HistoryMode; select?: string | null } = {},
): void {
  const ws = useWorkspace.getState();
  const pane = opts.pane ?? ws.activePane;
  const from = getActiveTab(pane).path;
  ws.setPath(path, opts);
  if (useApp.getState().syncBrowse && ws.dualPane && pane === ws.activePane)
    followInOtherPane(pane, from, path, opts.history ?? "push");
}

/** Synchronized browsing: the other pane makes the same move when it can. */
function followInOtherPane(pane: PaneId, from: string, to: string, mode: HistoryMode): void {
  if (isVirtualPath(from) || isVirtualPath(to)) return;
  const other = pane === "left" ? "right" : "left";
  const { path: otherPath, history } = getActiveTab(other);
  if (isVirtualPath(otherPath)) return;
  const target = mirrorMove(from, to, otherPath);
  if (!target) return;
  // Into a subfolder only if the other pane has one by that name.
  const listed = useDirCache.getState().dirs[otherPath]?.entries;
  if (target !== parent(otherPath) && !listed?.some((e) => e.path === target && isFolderLike(e))) return;
  // Back/Forward walk the other pane's history too when it leads to the same place.
  const step = mode === "back" ? -1 : mode === "forward" ? 1 : 0;
  const walks = step !== 0 && history.stack[history.index + step] === target;
  useWorkspace.getState().setPath(target, {
    pane: other,
    history: walks ? mode : "push",
    select: target === parent(otherPath) ? otherPath : undefined,
  });
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

/** Jumps `steps` places back (negative) or forward in the active tab's history. */
export function goHistory(steps: number): void {
  const mode = steps < 0 ? "back" : "forward";
  for (let i = 0; i < Math.abs(steps); i++) {
    const { history } = getActiveTab();
    const target = history.stack[history.index + (steps < 0 ? -1 : 1)];
    if (target === undefined) return;
    navigateTo(target, { history: mode });
  }
}

/** Enclosing folder; the folder we came from stays selected, like Finder. */
export function goUp(): void {
  const { path } = getActiveTab();
  // Leaving search results goes back to the folder that was searched.
  const scope = parseSearchPath(path)?.scope;
  if (scope) {
    navigateTo(scope);
    return;
  }
  const inArchive = archiveParent(path);
  if (inArchive) {
    navigateTo(inArchive.path, { select: inArchive.select });
    return;
  }
  const onServer = remoteParent(path);
  if (onServer) {
    navigateTo(onServer.path, { select: onServer.select });
    return;
  }
  if (isRemotePath(path)) return;
  const up = parent(path);
  if (up) navigateTo(up, { select: path });
}

export function reload(): void {
  const { path } = getActiveTab();
  clearFolderSizes(path);
  void useDirCache.getState().load(path);
}

/** The active tab's real folder (a search's scope), for actions that need one. */
export function currentFolder(pane?: PaneId): string {
  return realFolder(getActiveTab(pane).path);
}

/** New items can't be created in (or pasted into) search results. */
export function writableFolder(pane?: PaneId): string | null {
  const { path } = getActiveTab(pane);
  if (isArchivePath(path)) {
    toast(t("Archives are read-only. Extract the archive to change what’s in it."));
    return null;
  }
  if (!isSearchPath(path)) return path;
  toast(t("Search results aren’t a folder. Open a folder to add items to it."));
  return null;
}

/** Items inside an archive can only be opened and copied out. Returns true (and says so) if any are. */
export function refuseArchiveMembers(paths: readonly string[]): boolean {
  if (!paths.some(isArchivePath)) return false;
  toast(t("Archives are read-only. Copy items out with F5 or by dragging them to a folder."));
  return true;
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
  // Archives open like folders (Extract Here unpacks them).
  if (
    entries.length === 1 &&
    first?.kind === "file" &&
    isArchiveName(first.name) &&
    !isArchivePath(first.path)
  ) {
    navigateTo(archivePath(first.path));
    return;
  }
  for (const e of entries) {
    if (isFolderLike(e)) continue;
    try {
      // A file inside an archive or on a server is copied to a temporary folder first.
      const real = await materialize(e.path);
      await unwrap(commands.openPath(real));
    } catch (err) {
      toast.error(err instanceof CommandError ? err.message : t("Couldn’t open “{name}”.", { name: e.name }));
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
    toast.error(t("Enter an absolute path, or one starting with ~."));
    return false;
  }
  try {
    const entry = await unwrap(commands.statPath(path));
    if (isFolderLike(entry) || entry.kind === "package") navigateTo(entry.path);
    else navigateTo(parent(entry.path) ?? "/", { select: entry.path });
    return true;
  } catch (err) {
    const e = toAppError(err);
    toast.error(
      e.kind === "notFound"
        ? t("The folder “{path}” can’t be found.", { path })
        : new CommandError(e).message,
    );
    return false;
  }
}
