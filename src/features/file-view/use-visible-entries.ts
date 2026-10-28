import { useMemo } from "react";
import type { FileEntry } from "@/lib/ipc";
import { filterEntries, sortEntries } from "@/lib/sort";
import { useApp } from "@/stores/app-store";
import { type DirState, useDirCache } from "@/stores/dir-cache-store";
import { useFolderSizes } from "@/stores/folder-size-store";
import { type PaneId, type TabState, useActiveTab } from "@/stores/workspace-store";

export interface VisibleEntries {
  tab: TabState;
  dir: DirState | undefined;
  entries: FileEntry[];
  order: string[];
}

/** The active tab's directory after hidden/filter/sort are applied — exactly what the list renders. */
export function useVisibleEntries(pane: PaneId): VisibleEntries {
  const tab = useActiveTab(pane);
  const dir = useDirCache((s) => s.dirs[tab.path]);
  const showHidden = useApp((s) => s.showHidden);
  const { filter, sort } = tab.view;
  const raw = dir?.entries;
  // Measured folder sizes only matter (and only re-sort) when sorting by size.
  const sizes = useFolderSizes((s) => (sort.field === "size" ? s.sizes : undefined));

  const entries = useMemo(
    () => (raw ? sortEntries(filterEntries(raw, { showHidden, filter }), sort, sizes) : []),
    [raw, showHidden, filter, sort, sizes],
  );
  const order = useMemo(() => entries.map((e) => e.path), [entries]);
  return { tab, dir, entries, order };
}
