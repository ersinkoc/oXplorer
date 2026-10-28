import { LazyStore } from "@tauri-apps/plugin-store";
import { parseArchivePath } from "@/lib/archive-path";
import { parseSearchPath } from "@/lib/search-path";
import { EMPTY_SELECTION } from "@/lib/selection";
import { DEFAULT_SORT, type SortConfig } from "@/lib/sort";
import {
  newTab,
  PANES,
  type PaneId,
  type PaneState,
  type PreviewLayout,
  type TabState,
  useWorkspace,
  type ViewMode,
} from "@/stores/workspace-store";

/** Tabs, panes and layout as stored on disk between launches. */
export interface Session {
  version: 1;
  panes: Record<PaneId, { tabs: SessionTab[]; active: number }>;
  activePane: PaneId;
  dualPane: boolean;
  split: number;
  preview: PreviewLayout;
}

interface SessionTab {
  id: string;
  path: string;
  history: { stack: string[]; index: number };
  view: { mode: ViewMode; sort: SortConfig };
  pinned: boolean;
  /** Scroll offset of the tab's current folder. */
  scroll: number;
}

const HISTORY_KEEP = 50;
const SAVE_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Scroll positions: per tab and folder, so Back and restored tabs land where
// the user left off.

const scrolls = new Map<string, number>();
const scrollKey = (tabId: string, path: string) => `${tabId}\n${path}`;

export function rememberScroll(tabId: string, path: string, top: number): void {
  scrolls.set(scrollKey(tabId, path), top);
}

export function recallScroll(tabId: string, path: string): number {
  return scrolls.get(scrollKey(tabId, path)) ?? 0;
}

// ---------------------------------------------------------------------------

export function toSession(s: ReturnType<typeof useWorkspace.getState>): Session {
  const pane = (p: PaneState) => ({
    active: Math.max(
      0,
      p.tabs.findIndex((t) => t.id === p.activeTabId),
    ),
    tabs: p.tabs.map((t): SessionTab => {
      // Keep the newest history around the current position.
      const start = Math.max(0, t.history.index - HISTORY_KEEP + 1);
      return {
        id: t.id,
        path: t.path,
        history: {
          stack: t.history.stack.slice(start, start + HISTORY_KEEP),
          index: t.history.index - start,
        },
        view: { mode: t.view.mode, sort: t.view.sort },
        pinned: t.pinned,
        scroll: Math.round(recallScroll(t.id, t.path)),
      };
    }),
  });
  return {
    version: 1,
    panes: { left: pane(s.panes.left), right: pane(s.panes.right) },
    activePane: s.activePane,
    dualPane: s.dualPane,
    split: s.split,
    preview: { ...s.preview },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function restoreTab(raw: unknown): TabState | null {
  if (!isRecord(raw) || typeof raw.path !== "string") return null;
  if (!raw.path.startsWith("/") && !parseSearchPath(raw.path) && !parseArchivePath(raw.path)) return null;
  const path = raw.path;
  const h = isRecord(raw.history) ? raw.history : {};
  const stack = Array.isArray(h.stack) ? h.stack.filter((p): p is string => typeof p === "string") : [];
  const index = typeof h.index === "number" ? h.index : -1;
  const history = stack[index] === path ? { stack, index } : { stack: [path], index: 0 };
  const v = isRecord(raw.view) ? raw.view : {};
  const sort =
    isRecord(v.sort) &&
    typeof v.sort.field === "string" &&
    (v.sort.direction === "asc" || v.sort.direction === "desc")
      ? (v.sort as unknown as SortConfig)
      : DEFAULT_SORT;
  const tab = newTab(path, {
    id: typeof raw.id === "string" ? raw.id : undefined,
    history,
    view: { mode: v.mode === "icons" || v.mode === "columns" ? v.mode : "list", sort, filter: "" },
    selection: EMPTY_SELECTION,
    pinned: raw.pinned === true,
  });
  if (typeof raw.scroll === "number" && raw.scroll > 0) rememberScroll(tab.id, path, raw.scroll);
  return tab;
}

/**
 * Rebuilds workspace state from what `toSession` stored, tolerating partial or
 * outdated data. Panes that end up without tabs open `fallback`.
 */
export function fromSession(raw: unknown, fallback: string) {
  const data = isRecord(raw) && raw.version === 1 ? raw : {};
  const panesRaw = isRecord(data.panes) ? data.panes : {};
  const panes = {} as Record<PaneId, PaneState>;
  for (const id of PANES) {
    const p = isRecord(panesRaw[id]) ? panesRaw[id] : {};
    const tabs = (Array.isArray(p.tabs) ? p.tabs : []).map(restoreTab).filter((t) => t !== null);
    // Pinned tabs form a prefix.
    tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    if (tabs.length === 0) tabs.push(newTab(fallback));
    const active = typeof p.active === "number" ? p.active : 0;
    const rawTabs = Array.isArray(p.tabs) ? p.tabs : [];
    const activeId = isRecord(rawTabs[active]) ? rawTabs[active].id : undefined;
    panes[id] = { tabs, activeTabId: tabs.find((t) => t.id === activeId)?.id ?? tabs[0]?.id ?? "" };
  }
  const dualPane = data.dualPane === true;
  const preview = isRecord(data.preview) ? data.preview : {};
  return {
    panes,
    dualPane,
    activePane: dualPane && data.activePane === "right" ? ("right" as const) : ("left" as const),
    split: typeof data.split === "number" ? data.split : 0.5,
    preview: {
      visible: preview.visible === true,
      width: typeof preview.width === "number" ? preview.width : 320,
    },
  };
}

// ---------------------------------------------------------------------------

const store = new LazyStore("session.json");

export async function loadSession(): Promise<unknown> {
  try {
    return await store.get("session");
  } catch (err) {
    console.warn("failed to load session", err);
    return undefined;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;

export function saveSessionSoon(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    void store
      .set("session", toSession(useWorkspace.getState()))
      .catch((err: unknown) => console.warn("failed to save session", err));
  }, SAVE_DELAY_MS);
}

/** Saves the session whenever tabs or layout change. Returns the unsubscribe. */
export function autosaveSession(): () => void {
  return useWorkspace.subscribe((s, prev) => {
    if (
      s.panes !== prev.panes ||
      s.dualPane !== prev.dualPane ||
      s.activePane !== prev.activePane ||
      s.split !== prev.split ||
      s.preview !== prev.preview
    )
      saveSessionSoon();
  });
}
