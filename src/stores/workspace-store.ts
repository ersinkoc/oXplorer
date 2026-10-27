import { castDraft, enableMapSet } from "immer";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { EMPTY_SELECTION, type Selection } from "@/lib/selection";
import { DEFAULT_SORT, type SortConfig } from "@/lib/sort";

enableMapSet();

export type PaneId = "left" | "right";
export type ViewMode = "list" | "icons" | "columns";

export const PANES: readonly PaneId[] = ["left", "right"];
export const otherPane = (pane: PaneId): PaneId => (pane === "left" ? "right" : "left");

export interface TabView {
  mode: ViewMode;
  sort: SortConfig;
  filter: string;
}

export interface TabState {
  id: string;
  path: string;
  history: { stack: string[]; index: number };
  view: TabView;
  selection: Selection;
  pinned: boolean;
}

export interface PaneState {
  tabs: TabState[];
  activeTabId: string;
}

export interface PreviewLayout {
  visible: boolean;
  /** Width in px. */
  width: number;
}

export type HistoryMode = "push" | "back" | "forward" | "replace";

export const SPLIT_LIMITS = { min: 0.2, max: 0.8 } as const;
export const PREVIEW_LIMITS = { min: 220, max: 720, default: 320 } as const;

interface WorkspaceState {
  panes: Record<PaneId, PaneState>;
  activePane: PaneId;
  dualPane: boolean;
  /** Left pane's share of the width in dual-pane mode. */
  split: number;
  preview: PreviewLayout;

  /** Points the active tab of `pane` at `path`. The pane loads the directory. */
  setPath: (path: string, opts?: { pane?: PaneId; history?: HistoryMode; select?: string | null }) => void;
  setSelection: (selection: Selection, pane?: PaneId) => void;
  updateView: (patch: Partial<TabView>, pane?: PaneId) => void;

  setActivePane: (pane: PaneId) => void;
  setDualPane: (on: boolean) => void;
  swapPanes: () => void;
  setSplit: (ratio: number) => void;
  setPreview: (patch: Partial<PreviewLayout>) => void;

  /** Opens `path` in a new tab at the end of `pane` (pinned tabs stay first). */
  openTab: (path: string, opts?: { pane?: PaneId; activate?: boolean; select?: string | null }) => string;
  /** Returns false when it was the pane's last tab (nothing is closed then). */
  closeTab: (pane: PaneId, id: string) => boolean;
  closeOtherTabs: (pane: PaneId, id: string) => void;
  closeTabsToRight: (pane: PaneId, id: string) => void;
  activateTab: (pane: PaneId, id: string) => void;
  /** Activates the tab `delta` positions away, wrapping around. */
  cycleTab: (delta: number) => void;
  /** Moves a tab to `index` within `toPane` (the same or the other pane). */
  moveTab: (pane: PaneId, id: string, toPane: PaneId, index: number) => void;
  togglePin: (pane: PaneId, id: string) => void;
}

export function newTab(path: string, init: Partial<Omit<TabState, "path">> = {}): TabState {
  return {
    id: init.id ?? `tab-${crypto.randomUUID()}`,
    path,
    history: init.history ?? { stack: [path], index: 0 },
    view: init.view ?? { mode: "list", sort: DEFAULT_SORT, filter: "" },
    selection: init.selection ?? EMPTY_SELECTION,
    pinned: init.pinned ?? false,
  };
}

export function initialPane(path: string): PaneState {
  const tab = newTab(path);
  return { tabs: [tab], activeTabId: tab.id };
}

export function activeTabOf(pane: PaneState): TabState {
  const tab = pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
  if (!tab) throw new Error("pane without tabs");
  return tab;
}

/** Index of the first unpinned tab: pinned tabs always form a prefix. */
function pinnedCount(pane: PaneState): number {
  const i = pane.tabs.findIndex((t) => !t.pinned);
  return i < 0 ? pane.tabs.length : i;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** After removing tabs, activates the right neighbor of the old active tab (or the last tab). */
function removeTabs(pane: PaneState, drop: (t: TabState, i: number) => boolean): void {
  const activeIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
  const kept = pane.tabs.filter((t, i) => !drop(t, i));
  if (kept.length === 0) return;
  if (!kept.some((t) => t.id === pane.activeTabId)) {
    const right = pane.tabs.slice(activeIndex + 1).find((t) => kept.includes(t));
    pane.activeTabId = (right ?? kept.at(-1) ?? kept[0])?.id ?? pane.activeTabId;
  }
  pane.tabs = kept;
}

export const useWorkspace = create<WorkspaceState>()(
  immer((set, get) => ({
    // The real home path is set by `bootstrap` before the first render of the list.
    panes: { left: initialPane("/"), right: initialPane("/") },
    activePane: "left",
    dualPane: false,
    split: 0.5,
    preview: { visible: false, width: PREVIEW_LIMITS.default },

    setPath: (path, opts = {}) =>
      set((s) => {
        const tab = activeTabOf(s.panes[opts.pane ?? s.activePane]);
        const h = tab.history;
        switch (opts.history ?? "push") {
          case "push":
            if (h.stack[h.index] === path) break;
            h.stack.splice(h.index + 1);
            h.stack.push(path);
            h.index = h.stack.length - 1;
            break;
          case "back":
            h.index = Math.max(0, h.index - 1);
            break;
          case "forward":
            h.index = Math.min(h.stack.length - 1, h.index + 1);
            break;
          case "replace":
            h.stack[h.index] = path;
            break;
        }
        tab.path = path;
        tab.view.filter = "";
        tab.selection = opts.select
          ? { paths: new Set([opts.select]), anchor: opts.select, focus: opts.select }
          : EMPTY_SELECTION;
      }),

    setSelection: (selection, pane) =>
      set((s) => {
        activeTabOf(s.panes[pane ?? s.activePane]).selection = selection;
      }),

    updateView: (patch, pane) =>
      set((s) => {
        const tab = activeTabOf(s.panes[pane ?? s.activePane]);
        Object.assign(tab.view, patch);
      }),

    setActivePane: (pane) => {
      if (get().activePane === pane || (pane === "right" && !get().dualPane)) return;
      set({ activePane: pane });
    },

    setDualPane: (on) =>
      set((s) => {
        s.dualPane = on;
        if (!on) s.activePane = "left";
      }),

    swapPanes: () =>
      set((s) => {
        const { left, right } = s.panes;
        s.panes = { left: right, right: left };
        s.activePane = s.dualPane ? (s.activePane === "left" ? "right" : "left") : "left";
      }),

    setSplit: (ratio) => set({ split: clamp(ratio, SPLIT_LIMITS.min, SPLIT_LIMITS.max) }),

    setPreview: (patch) =>
      set((s) => {
        Object.assign(s.preview, patch);
        s.preview.width = clamp(Math.round(s.preview.width), PREVIEW_LIMITS.min, PREVIEW_LIMITS.max);
      }),

    openTab: (path, opts = {}) => {
      const tab = newTab(path);
      if (opts.select)
        tab.selection = { paths: new Set([opts.select]), anchor: opts.select, focus: opts.select };
      set((s) => {
        const pane = opts.pane ?? s.activePane;
        if (pane === "right") s.dualPane = true;
        s.panes[pane].tabs.push(castDraft(tab));
        if (opts.activate ?? true) {
          s.panes[pane].activeTabId = tab.id;
          s.activePane = pane;
        }
      });
      return tab.id;
    },

    closeTab: (pane, id) => {
      if (get().panes[pane].tabs.length <= 1) return false;
      set((s) => removeTabs(s.panes[pane], (t) => t.id === id));
      return true;
    },

    closeOtherTabs: (pane, id) =>
      set((s) => {
        s.panes[pane].activeTabId = id;
        removeTabs(s.panes[pane], (t) => t.id !== id && !t.pinned);
      }),

    closeTabsToRight: (pane, id) =>
      set((s) => {
        const p = s.panes[pane];
        const at = p.tabs.findIndex((t) => t.id === id);
        if (at < 0) return;
        removeTabs(p, (t, i) => i > at && !t.pinned);
      }),

    activateTab: (pane, id) =>
      set((s) => {
        if (!s.panes[pane].tabs.some((t) => t.id === id)) return;
        s.panes[pane].activeTabId = id;
        if (pane === "left" || s.dualPane) s.activePane = pane;
      }),

    cycleTab: (delta) =>
      set((s) => {
        const p = s.panes[s.activePane];
        const at = p.tabs.findIndex((t) => t.id === p.activeTabId);
        const n = p.tabs.length;
        const next = p.tabs[(((at + delta) % n) + n) % n];
        if (next) p.activeTabId = next.id;
      }),

    moveTab: (pane, id, toPane, index) =>
      set((s) => {
        const from = s.panes[pane];
        const at = from.tabs.findIndex((t) => t.id === id);
        const tab = from.tabs[at];
        if (!tab) return;
        const to = s.panes[toPane];
        if (pane === toPane) {
          from.tabs.splice(at, 1);
          // Pinned and unpinned tabs don't mix.
          const pins = pinnedCount(from);
          const lo = tab.pinned ? 0 : pins;
          const hi = tab.pinned ? pins : from.tabs.length;
          from.tabs.splice(clamp(index > at ? index - 1 : index, lo, hi), 0, tab);
          return;
        }
        from.tabs.splice(at, 1);
        if (from.tabs.length === 0) {
          // A pane never ends up empty: it keeps a fresh tab on the same folder.
          const stay = newTab(tab.path, { view: { ...tab.view, filter: "" } });
          from.tabs.push(castDraft(stay));
          from.activeTabId = stay.id;
        } else if (from.activeTabId === id) {
          from.activeTabId = (from.tabs[Math.min(at, from.tabs.length - 1)] ?? from.tabs[0])?.id ?? "";
        }
        const pins = pinnedCount(to);
        const lo = tab.pinned ? 0 : pins;
        const hi = tab.pinned ? pins : to.tabs.length;
        to.tabs.splice(clamp(index, lo, hi), 0, tab);
        to.activeTabId = tab.id;
        if (toPane === "right") s.dualPane = true;
        s.activePane = toPane;
      }),

    togglePin: (pane, id) =>
      set((s) => {
        const p = s.panes[pane];
        const at = p.tabs.findIndex((t) => t.id === id);
        const tab = p.tabs[at];
        if (!tab) return;
        p.tabs.splice(at, 1);
        tab.pinned = !tab.pinned;
        // Newly pinned go to the end of the pinned group; unpinned to the start of the rest.
        p.tabs.splice(pinnedCount(p), 0, tab);
      }),
  })),
);

export function useActiveTab(pane?: PaneId): TabState {
  return useWorkspace((s) => activeTabOf(s.panes[pane ?? s.activePane]));
}

export function getActiveTab(pane?: PaneId): TabState {
  const s = useWorkspace.getState();
  return activeTabOf(s.panes[pane ?? s.activePane]);
}

/** Panes currently on screen. */
export function visiblePanes(s: { dualPane: boolean }): PaneId[] {
  return s.dualPane ? ["left", "right"] : ["left"];
}
