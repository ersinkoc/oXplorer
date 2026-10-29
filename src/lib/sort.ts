import { isFolderLike, kindLabel } from "@/lib/format";
import { globMatcher } from "@/lib/glob";
import type { FileEntry } from "@/lib/ipc";

export type SortField = "name" | "modified" | "size" | "kind";

export interface SortConfig {
  field: SortField;
  direction: "asc" | "desc";
  foldersFirst: boolean;
}

/** Finder flips direction on the active column; numeric/date columns start descending. */
export function nextSort(current: SortConfig, field: SortField): SortConfig {
  if (current.field === field) return { ...current, direction: current.direction === "asc" ? "desc" : "asc" };
  return { ...current, field, direction: field === "modified" || field === "size" ? "desc" : "asc" };
}

export const DEFAULT_SORT: SortConfig = { field: "name", direction: "asc", foldersFirst: true };

/** Finder's natural order: "file2" < "file10", case-insensitive, accent-aware. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const compareNames = collator.compare;

const MARKS = /\p{M}/gu;
const DIGITS = /\d+/g;
const SYMBOLS = /[^\p{L}\p{N}]/gu;
const keyCache = new WeakMap<FileEntry, string>();

/**
 * Precomputed equivalent of `compareNames` ordering: accents stripped, lowercased,
 * punctuation pushed below digits (as ICU does), digit runs zero-padded so plain
 * string comparison is numeric-aware. Sorting 100k
 * names this way is several times faster than calling the collator per comparison.
 */
export function naturalKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(SYMBOLS, (c) => `\u0001${c}`)
    .replace(DIGITS, (d) => d.replace(/^0+(?=\d)/, "").padStart(20, "0"));
}

function keyOf(e: FileEntry): string {
  let k = keyCache.get(e);
  if (k === undefined) {
    k = naturalKey(e.name);
    keyCache.set(e, k);
  }
  return k;
}

/** Measured folder sizes by path (View → Calculate Folder Sizes). */
export type KnownSizes = Readonly<Record<string, { bytes: number; done: boolean }>>;

function fieldValue(e: FileEntry, folder: boolean, field: SortField, sizes?: KnownSizes): number | string {
  switch (field) {
    case "name":
      return 0;
    case "modified":
      return e.modifiedMs;
    case "size":
      if (!folder) return e.size;
      return sizes?.[e.path]?.done ? (sizes[e.path]?.bytes ?? -1) : -1;
    case "kind":
      return naturalKey(kindLabel(e));
  }
}

export function sortEntries(
  entries: readonly FileEntry[],
  sort: SortConfig,
  sizes?: KnownSizes,
): FileEntry[] {
  const dir = sort.direction === "asc" ? 1 : -1;
  // Decorate once so the comparator does no per-call work.
  const rows = entries.map((e) => {
    const folder = isFolderLike(e);
    return { e, folder, value: fieldValue(e, folder, sort.field, sizes), key: keyOf(e) };
  });
  rows.sort((a, b) => {
    if (sort.foldersFirst && a.folder !== b.folder) return a.folder ? -1 : 1;
    // Ties on the chosen field fall back to name so the order is stable and predictable.
    let c = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    if (c === 0) c = a.key < b.key ? -1 : a.key > b.key ? 1 : compareNames(a.e.name, b.e.name);
    return c * dir;
  });
  return rows.map((r) => r.e);
}

export interface VisibilityOptions {
  showHidden: boolean;
  filter: string;
}

/** The filter field takes plain text or patterns like `*.jpg; *.png` (see `globMatcher`). */
export function filterEntries(entries: readonly FileEntry[], opts: VisibilityOptions): FileEntry[] {
  const match = globMatcher(opts.filter);
  return entries.filter(
    (e) => !e.isSystemJunk && (opts.showHidden || !e.isHidden) && (!match || match(e.name)),
  );
}
