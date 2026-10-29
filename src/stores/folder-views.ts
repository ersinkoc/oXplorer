import { LazyStore } from "@tauri-apps/plugin-store";
import { DEFAULT_SORT, type SortConfig } from "@/lib/sort";
import type { ViewMode } from "@/stores/workspace-store";

/** How a folder was last shown, like Finder's per-folder view options. */
export interface FolderView {
  mode: ViewMode;
  sort: SortConfig;
}

const KEEP = 500;
const SAVE_DELAY_MS = 1000;

/** Oldest first (a Map keeps insertion order), so trimming drops the least recent. */
const views = new Map<string, FolderView>();
const store = new LazyStore("folder-views.json");
let timer: ReturnType<typeof setTimeout> | undefined;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** A stored `{ mode, sort }`, with anything unexpected replaced by the defaults. */
export function parseView(raw: unknown): FolderView {
  const v = isRecord(raw) ? raw : {};
  const sort =
    isRecord(v.sort) &&
    typeof v.sort.field === "string" &&
    (v.sort.direction === "asc" || v.sort.direction === "desc")
      ? (v.sort as unknown as SortConfig)
      : DEFAULT_SORT;
  return { mode: v.mode === "icons" || v.mode === "columns" ? v.mode : "list", sort };
}

async function stored(): Promise<[string, FolderView][]> {
  const raw = await store.get<unknown>("views");
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) =>
    Array.isArray(item) && typeof item[0] === "string"
      ? [[item[0], parseView(item[1])] as [string, FolderView]]
      : [],
  );
}

export async function loadFolderViews(): Promise<void> {
  try {
    for (const [path, view] of await stored()) views.set(path, view);
  } catch (err) {
    console.warn("failed to load folder views", err);
  }
}

/** Other windows save to the same file: what they remembered is kept, as older entries. */
async function save(): Promise<void> {
  const others = (await stored()).filter(([path]) => !views.has(path));
  const merged = [...others, ...views].slice(-KEEP);
  views.clear();
  for (const [path, view] of merged) views.set(path, view);
  await store.set("views", merged);
}

export function rememberedView(path: string): FolderView | undefined {
  return views.get(path);
}

/** Called when the user changes how `path` is shown (view mode or sorting). */
export function rememberView(path: string, view: FolderView): void {
  views.delete(path);
  views.set(path, { mode: view.mode, sort: { ...view.sort } });
  for (const oldest of views.keys()) {
    if (views.size <= KEEP) break;
    views.delete(oldest);
  }
  clearTimeout(timer);
  timer = setTimeout(() => void save().catch(() => {}), SAVE_DELAY_MS);
}
