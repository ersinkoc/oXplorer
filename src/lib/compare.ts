import type { FileEntry } from "@/lib/ipc";

/** How an item in one pane relates to the item of the same name in the other. */
export type CompareMark = "only" | "newer" | "older" | "different" | "same";

/** File systems like FAT/exFAT store times in 2-second steps. */
const TIME_SLACK_MS = 2000;

/**
 * Pairs items by name (case-insensitively, like the default APFS volume) and
 * marks each side. Folders are only checked for presence; files by
 * modification time, then size.
 */
export function compareEntries(
  left: readonly FileEntry[],
  right: readonly FileEntry[],
): { left: Map<string, CompareMark>; right: Map<string, CompareMark> } {
  const key = (e: FileEntry) => e.name.normalize("NFC").toLowerCase();
  const rightByKey = new Map(right.map((e) => [key(e), e]));
  const leftKeys = new Set(left.map(key));
  const marks = { left: new Map<string, CompareMark>(), right: new Map<string, CompareMark>() };

  for (const l of left) {
    const r = rightByKey.get(key(l));
    if (!r) {
      marks.left.set(l.name, "only");
      continue;
    }
    const [lm, rm] = markPair(l, r);
    marks.left.set(l.name, lm);
    marks.right.set(r.name, rm);
  }
  for (const r of right) if (!leftKeys.has(key(r))) marks.right.set(r.name, "only");
  return marks;
}

function markPair(l: FileEntry, r: FileEntry): [CompareMark, CompareMark] {
  const folder = (e: FileEntry) => e.kind === "dir" || e.kind === "package";
  if (folder(l) || folder(r)) return folder(l) === folder(r) ? ["same", "same"] : ["different", "different"];
  const dt = l.modifiedMs - r.modifiedMs;
  if (dt > TIME_SLACK_MS) return ["newer", "older"];
  if (dt < -TIME_SLACK_MS) return ["older", "newer"];
  return l.size === r.size ? ["same", "same"] : ["different", "different"];
}

/** Items worth copying to the other side: missing there, or newer here. */
export function differences(marks: ReadonlyMap<string, CompareMark>): Set<string> {
  return new Set([...marks].filter(([, m]) => m === "only" || m === "newer").map(([name]) => name));
}
