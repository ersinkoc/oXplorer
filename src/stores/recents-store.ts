import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";

/** A folder the user opened: how often and when last (epoch ms). */
export interface Visit {
  path: string;
  count: number;
  last: number;
}

const KEEP = 200;
const SAVE_DELAY_MS = 1000;
const DAY = 86_400_000;

/** Visit count weighted by recency, like Firefox's frecency buckets. */
export function frecency(v: Visit, now = Date.now()): number {
  const age = now - v.last;
  const weight = age < 4 * DAY ? 100 : age < 14 * DAY ? 70 : age < 31 * DAY ? 50 : age < 90 * DAY ? 30 : 10;
  return v.count * weight;
}

export const useRecents = create<{ visits: Visit[] }>()(() => ({ visits: [] }));

const store = new LazyStore("recents.json");
let timer: ReturnType<typeof setTimeout> | undefined;

export async function loadRecents(): Promise<void> {
  try {
    const raw = await store.get<Visit[]>("visits");
    if (Array.isArray(raw))
      useRecents.setState({
        visits: raw.filter((v) => typeof v?.path === "string" && v.path.startsWith("/")),
      });
  } catch (err) {
    console.warn("failed to load recent folders", err);
  }
}

export function recordVisit(path: string): void {
  if (!path.startsWith("/")) return;
  const now = Date.now();
  const visits = useRecents.getState().visits;
  const prev = visits.find((v) => v.path === path);
  const next = [{ path, count: (prev?.count ?? 0) + 1, last: now }, ...visits.filter((v) => v.path !== path)]
    .sort((a, b) => frecency(b, now) - frecency(a, now))
    .slice(0, KEEP);
  useRecents.setState({ visits: next });
  clearTimeout(timer);
  timer = setTimeout(() => void store.set("visits", next).catch(() => {}), SAVE_DELAY_MS);
}

export function clearRecents(): void {
  useRecents.setState({ visits: [] });
  void store.set("visits", []).catch(() => {});
}

/** Most relevant folders first. */
export function rankedVisits(): Visit[] {
  const now = Date.now();
  return [...useRecents.getState().visits].sort((a, b) => frecency(b, now) - frecency(a, now));
}
