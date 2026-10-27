import { create } from "zustand";
import type { ContentMatch } from "@/bindings";

export interface SearchInfo {
  /** Content mode: the first matching line per result path. */
  matches: ReadonlyMap<string, ContentMatch>;
  scanned: number;
  running: boolean;
  /** Set when the search ended. */
  outcome: { total: number; cancelled: boolean; truncated: boolean } | null;
}

interface SearchState {
  searches: Record<string, SearchInfo>;
  patch: (path: string, next: Partial<SearchInfo>) => void;
}

export const EMPTY_SEARCH: SearchInfo = { matches: new Map(), scanned: 0, running: false, outcome: null };

/** Per search path: what the list itself doesn't show (progress, match lines). */
export const useSearchInfo = create<SearchState>()((set) => ({
  searches: {},
  patch: (path, next) =>
    set((s) => ({ searches: { ...s.searches, [path]: { ...(s.searches[path] ?? EMPTY_SEARCH), ...next } } })),
}));
