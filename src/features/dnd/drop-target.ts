import type { FileEntry } from "@/lib/ipc";
import { parent } from "@/lib/path";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";

/** Folder path of the drop target under a viewport point, if any. */
export function dropDirAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-dir]");
  return el?.dataset.dropDir ?? null;
}

/**
 * Folder a drag hovering at a viewport point would spring open: an item in a
 * pane's file view (not its background, a tab or the sidebar), with that pane.
 */
export function springTargetAt(x: number, y: number): { pane: "left" | "right"; dir: string } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-dir]");
  const dir = el?.dataset.dropDir;
  if (!el || !dir || el.closest("[role=tab]")) return null;
  const pane = el.closest<HTMLElement>("[data-pane]")?.dataset.pane;
  return pane === "left" || pane === "right" ? { pane, dir } : null;
}

/** Whether a viewport point is in the sidebar's Favorites list but not on an item that takes drops. */
export function favoritesZoneAt(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  return !!el?.closest("[data-drop-favorites]") && !el.closest("[data-drop-dir]");
}

/** The dragged paths that are folders on this Mac (known from the listings on screen). */
export function localFolders(paths: readonly string[]): string[] {
  const { dirs } = useDirCache.getState();
  return paths.filter((p) => {
    if (!p.startsWith("/")) return false;
    const entry = dirs[parent(p) ?? "/"]?.entries.find((e) => e.path === p);
    return entry?.kind === "dir";
  });
}

/** Session id of the terminal under a viewport point, if any. */
export function terminalAt(x: number, y: number): string | null {
  return (
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-terminal-id]")?.dataset.terminalId ?? null
  );
}

/** Mount point that contains `path` (the boot volume unless under a mounted volume). */
export function volumeOf(path: string): string {
  let best = "/";
  for (const v of useApp.getState().volumes) {
    const m = v.mountPoint;
    if (m !== "/" && (path === m || path.startsWith(`${m}/`)) && m.length > best.length) best = m;
  }
  return best;
}

/** Finder rule: same volume moves, across volumes copies; ⌥ forces a copy. */
export function dropMode(sources: readonly string[], dest: string, forceCopy: boolean): "copy" | "move" {
  if (forceCopy) return "copy";
  const destVolume = volumeOf(dest);
  return sources.every((s) => volumeOf(s) === destVolume) ? "move" : "copy";
}

/** Dropping into itself, a descendant, or back where everything already is does nothing. */
export function isValidDrop(sources: readonly string[], dest: string): boolean {
  if (sources.some((s) => dest === s || dest.startsWith(`${s}/`))) return false;
  return !sources.every((s) => parent(s) === dest);
}

export function dropDirFor(entry: FileEntry): string | undefined {
  const folder = entry.kind === "dir" || (entry.kind === "symlink" && entry.symlink?.targetIsDir);
  return folder ? entry.path : undefined;
}
