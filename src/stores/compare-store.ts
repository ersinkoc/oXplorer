import { useMemo } from "react";
import { create } from "zustand";
import { type CompareMark, compareEntries } from "@/lib/compare";
import { filterEntries } from "@/lib/sort";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { activeTabOf, type PaneId, useWorkspace } from "@/stores/workspace-store";

/** The two folders being compared; comparing ends when either pane leaves its folder. */
export const useCompare = create<{ pair: { left: string; right: string } | null }>()(() => ({ pair: null }));

/** Compare marks for `pane` by item name, or null when not comparing. */
export function useCompareMarks(pane: PaneId): ReadonlyMap<string, CompareMark> | null {
  const pair = useCompare((s) => s.pair);
  const leftPath = useWorkspace((s) => activeTabOf(s.panes.left).path);
  const rightPath = useWorkspace((s) => (s.dualPane ? activeTabOf(s.panes.right).path : null));
  const active = !!pair && pair.left === leftPath && pair.right === rightPath;
  const left = useDirCache((s) => (active ? s.dirs[leftPath]?.entries : undefined));
  const right = useDirCache((s) => (active && rightPath ? s.dirs[rightPath]?.entries : undefined));
  const showHidden = useApp((s) => s.showHidden);
  const marks = useMemo(() => {
    if (!left || !right) return null;
    const visible = (list: typeof left) => filterEntries(list, { showHidden, filter: "" });
    return compareEntries(visible(left), visible(right));
  }, [left, right, showHidden]);
  return marks ? marks[pane] : null;
}
