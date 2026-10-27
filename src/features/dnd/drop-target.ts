import type { FileEntry } from "@/lib/ipc";
import { parent } from "@/lib/path";
import { useApp } from "@/stores/app-store";

/** Folder path of the drop target under a viewport point, if any. */
export function dropDirAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-dir]");
  return el?.dataset.dropDir ?? null;
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
