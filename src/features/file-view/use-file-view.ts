import { useEffect, useRef } from "react";
import { openEntries } from "@/commands/navigation";
import { runCommand } from "@/commands/registry";
import { beginPotentialDrag } from "@/features/dnd/drag-controller";
import { showBackgroundMenu, showItemMenu } from "@/features/file-view/context-menu";
import { useVisibleEntries } from "@/features/file-view/use-visible-entries";
import { setPaneLayout } from "@/features/file-view/visible-order";
import { toggleQuickLook } from "@/features/preview/quick-look";
import type { FileEntry } from "@/lib/ipc";
import {
  type ClickMode,
  click,
  EMPTY_SELECTION,
  move,
  prune,
  type Selection,
  selectOne,
  typeAheadMatch,
} from "@/lib/selection";
import { useApp } from "@/stores/app-store";
import { recallScroll, rememberScroll, saveSessionSoon } from "@/stores/session";
import { type PaneId, useWorkspace } from "@/stores/workspace-store";

const TYPE_AHEAD_RESET_MS = 900;

export interface Layout {
  /** Items per row: 1 for the list, N for the icon grid. */
  columns: number;
  /** Height of one row in px, for PageUp/PageDown. */
  rowHeight: number;
}

/**
 * Selection, keyboard and focus behavior shared by every view mode. Views only
 * decide geometry (`Layout`) and rendering.
 */
export function useFileView(pane: PaneId, columns: number, scrollToIndex: (index: number) => void) {
  const visible = useVisibleEntries(pane);
  const { tab, dir, entries, order } = visible;
  const { selection } = tab;
  const active = useWorkspace((s) => s.activePane === pane);
  const editingPath = useApp((s) => s.editingPath);
  // Both panes may show the same folder; only the active one edits names.
  const renamingPath = useApp((s) => s.renaming);
  const renaming = active ? renamingPath : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const typeAhead = useRef({ text: "", at: 0 });
  const setSelection = (sel: Selection) => useWorkspace.getState().setSelection(sel, pane);

  useEffect(() => setPaneLayout(pane, { order, columns }), [pane, order, columns]);

  // Drop selected paths that disappeared — only once the listing is complete,
  // otherwise "go up and select the folder we came from" would be pruned mid-stream.
  const ready = dir?.status === "ready";
  useEffect(() => {
    if (!ready) return;
    const next = prune(selection, new Set(order));
    if (next !== selection) useWorkspace.getState().setSelection(next, pane);
  }, [ready, order, selection, pane]);

  const focusIndex = selection.focus ? order.indexOf(selection.focus) : -1;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollToIndex is recreated each render
  useEffect(() => {
    if (focusIndex >= 0) scrollToIndex(focusIndex);
  }, [focusIndex]);

  // Each tab remembers its scroll offset per folder (Back, tab switches, relaunch).
  // The offset can only be applied once the listing has its full height.
  const scrollKey = `${tab.id}\n${tab.path}\n${tab.view.mode}`;
  const restoredKey = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on scrollKey by design
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || restoredKey.current === scrollKey) return;
    const top = recallScroll(tab.id, tab.path);
    if (top > 0 && !ready) return;
    el.scrollTo({ top });
    restoredKey.current = scrollKey;
    if (focusIndex >= 0) scrollToIndex(focusIndex);
  }, [scrollKey, ready]);

  const onScroll = (e: React.UIEvent<HTMLElement>) => {
    // Ignore the clamping scroll events of a folder that is still loading.
    if (restoredKey.current !== scrollKey) return;
    rememberScroll(tab.id, tab.path, e.currentTarget.scrollTop);
    saveSessionSoon();
  };

  // New folder or newly active pane: keyboard focus goes to the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on navigation by design
  useEffect(() => {
    if (!active || useApp.getState().editingPath) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return;
    scrollRef.current?.focus();
  }, [tab.path, tab.id, tab.view.mode, active]);

  // Give keyboard focus back to the view after the path bar or a rename closes.
  useEffect(() => {
    if (active && !editingPath && !renaming) scrollRef.current?.focus();
  }, [active, editingPath, renaming]);

  const onKeyDown = (e: React.KeyboardEvent, layout: Layout) => {
    // Keys typed into an inline rename field are not navigation.
    if (e.metaKey || e.ctrlKey || e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      runCommand("file.rename");
      return;
    }
    if (e.key === "F2") {
      e.preventDefault();
      runCommand("file.rename");
      return;
    }
    if (e.key === "Tab" && !e.altKey && useWorkspace.getState().dualPane) {
      e.preventDefault();
      runCommand("pane.switch");
      return;
    }
    if (e.key === " " && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      toggleQuickLook();
      return;
    }
    const { columns, rowHeight } = layout;
    const rowsPerPage = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / rowHeight) - 1);
    const all = order.length;
    const moves: Record<string, number> = {
      ArrowDown: e.altKey ? all : columns,
      ArrowUp: e.altKey ? -all : -columns,
      PageDown: rowsPerPage * columns,
      PageUp: -rowsPerPage * columns,
      End: all,
      Home: -all,
      ...(columns > 1 ? { ArrowRight: 1, ArrowLeft: -1 } : {}),
    };
    const delta = moves[e.key];
    if (delta !== undefined) {
      e.preventDefault();
      setSelection(move(selection, order, delta, e.shiftKey));
      return;
    }
    if (e.key.length === 1 && !e.altKey && e.key !== " ") {
      e.preventDefault();
      const now = performance.now();
      const t = typeAhead.current;
      t.text = now - t.at > TYPE_AHEAD_RESET_MS ? e.key : t.text + e.key;
      t.at = now;
      const hit = typeAheadMatch(entries, t.text);
      if (hit) setSelection({ paths: new Set([hit]), anchor: hit, focus: hit });
    }
  };

  const onItemMouseDown = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.button !== 0 || e.ctrlKey) return;
    const mode: ClickMode = e.shiftKey ? "range" : e.metaKey ? "toggle" : "single";
    // A plain press on part of a multi-selection keeps it for dragging; if no drag
    // follows, the release narrows the selection to this item (Finder behavior).
    const keepForDrag = mode === "single" && selection.paths.has(entry.path) && selection.paths.size > 1;
    if (!keepForDrag) setSelection(click(selection, order, entry.path, mode));
    if (mode === "toggle" && selection.paths.has(entry.path)) return;
    beginPotentialDrag(
      e,
      () => {
        const sel = useWorkspace.getState().panes[pane].tabs.find((t) => t.id === tab.id)?.selection.paths;
        return sel ? order.filter((p) => sel.has(p)) : [entry.path];
      },
      keepForDrag ? () => setSelection(selectOne(entry.path)) : undefined,
    );
  };

  /** Right-click: act on the selection, or on the clicked item if it wasn't selected. */
  const onItemContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    let targets = entries.filter((x) => selection.paths.has(x.path));
    if (!selection.paths.has(entry.path)) {
      setSelection(selectOne(entry.path));
      targets = [entry];
    }
    void showItemMenu(targets);
  };

  const onBackgroundContextMenu = (e: React.MouseEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget && e.target !== e.currentTarget.firstChild) return;
    e.preventDefault();
    setSelection(EMPTY_SELECTION);
    void showBackgroundMenu();
  };

  const onItemDoubleClick = (entry: FileEntry) => {
    const selected = selection.paths.has(entry.path)
      ? entries.filter((x) => selection.paths.has(x.path))
      : [entry];
    void openEntries(selected);
  };

  /** Mouse-down on empty space clears the selection, as in Finder. */
  const onBackgroundMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (e.target === e.currentTarget || e.target === e.currentTarget.firstChild)
      setSelection(EMPTY_SELECTION);
  };

  return {
    ...visible,
    selection,
    scrollRef,
    focusIndex,
    onScroll,
    onKeyDown,
    onItemMouseDown,
    onItemDoubleClick,
    onItemContextMenu,
    onBackgroundMouseDown,
    onBackgroundContextMenu,
    renaming,
  };
}
