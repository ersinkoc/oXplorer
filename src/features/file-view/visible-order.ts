import type { PaneId } from "@/stores/workspace-store";

/**
 * What each pane shows, in on-screen order, plus its column count. Maintained
 * by the views so commands (Select All, Quick Look navigation) can act on it.
 */
interface PaneLayout {
  order: readonly string[];
  columns: number;
}

const layouts: Record<PaneId, PaneLayout> = {
  left: { order: [], columns: 1 },
  right: { order: [], columns: 1 },
};

export function setPaneLayout(pane: PaneId, layout: Partial<PaneLayout>): void {
  layouts[pane] = { ...layouts[pane], ...layout };
}

export function paneLayout(pane: PaneId): PaneLayout {
  return layouts[pane];
}
