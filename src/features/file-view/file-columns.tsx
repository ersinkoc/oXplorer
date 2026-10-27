import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import { memo, useEffect, useMemo, useRef } from "react";
import { ensureListed, goUp, navigateTo, openEntries } from "@/commands/navigation";
import { beginPotentialDrag } from "@/features/dnd/drag-controller";
import { useDrag } from "@/features/dnd/drag-store";
import { dropDirFor } from "@/features/dnd/drop-target";
import { showItemMenu } from "@/features/file-view/context-menu";
import { FileIcon } from "@/features/file-view/file-icon";
import { RenameInput } from "@/features/file-view/rename-input";
import { useFileView } from "@/features/file-view/use-file-view";
import { statusBody } from "@/features/file-view/view-states";
import { EntryPreview } from "@/features/preview/preview-pane";
import { isFolderLike } from "@/lib/format";
import type { FileEntry } from "@/lib/ipc";
import { parent } from "@/lib/path";
import { filterEntries, type SortConfig, sortEntries } from "@/lib/sort";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { type PaneId, useActiveTab } from "@/stores/workspace-store";

const COLUMN_WIDTH = 230;
const PREVIEW_WIDTH = 300;
const ROW_HEIGHT = 22;
const LAYOUT = { columns: 1, rowHeight: ROW_HEIGHT };
/** The column showing a selected folder's contents waits until the selection rests. */
const CHILD_DELAY_MS = 100;

/** Leftmost column: the home folder or mounted volume containing `path`, else the disk root. */
export function columnRoot(path: string, home: string, volumes: readonly string[]): string {
  const within = (root: string) => path === root || path.startsWith(`${root}/`);
  if (home !== "/" && within(home)) return home;
  const volume = volumes.filter((v) => v !== "/" && within(v)).sort((a, b) => b.length - a.length)[0];
  return volume ?? "/";
}

/** Folders from `root` down to, but not including, `path`. */
export function ancestorChain(root: string, path: string): string[] {
  const out: string[] = [];
  let p = parent(path);
  while (p && (p === root || p.startsWith(root === "/" ? "/" : `${root}/`))) {
    out.unshift(p);
    if (p === root) break;
    p = parent(p);
  }
  return out;
}

function useSortedEntries(path: string, sort: SortConfig): FileEntry[] {
  const raw = useDirCache((s) => s.dirs[path]?.entries);
  const showHidden = useApp((s) => s.showHidden);
  return useMemo(
    () => (raw ? sortEntries(filterEntries(raw, { showHidden, filter: "" }), sort) : []),
    [raw, showHidden, sort],
  );
}

/**
 * Column (Miller) view. The tab's folder is the focused column; the columns to
 * its left are its ancestors with the path highlighted, and on its right the
 * selected folder's contents, or a preview of the selected file.
 */
export function FileColumns({ pane }: { pane: PaneId }) {
  const path = useActiveTab(pane).path;
  const home = useApp((s) => s.home);
  const volumes = useApp((s) => s.volumes);
  const root = columnRoot(
    path,
    home,
    volumes.map((v) => v.mountPoint),
  );
  const ancestors = ancestorChain(root, path);
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the newest columns in view.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  });

  return (
    <div ref={scroller} className="file-list flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
      {ancestors.map((dir, i) => (
        <StaticColumn key={dir} pane={pane} path={dir} highlight={ancestors[i + 1] ?? path} />
      ))}
      <ActiveColumn key={path} pane={pane} root={root} />
    </div>
  );
}

function ActiveColumn({ pane, root }: { pane: PaneId; root: string }) {
  const view = useFileView(pane, 1, (i) => virtualizer.scrollToIndex(i, { align: "auto" }));
  const { tab, dir, entries, selection, scrollRef, focusIndex, renaming } = view;
  const dropTarget = useDrag((s) => s.target);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const body = statusBody(dir, entries, !!tab.view.filter);
  const selected = selection.paths.size === 1 ? entries.find((e) => selection.paths.has(e.path)) : undefined;

  /** → enters the selected folder and selects its first item, like Finder. */
  const enterSelected = () => {
    if (!selected || !isFolderLike(selected)) return;
    const raw = useDirCache.getState().dirs[selected.path]?.entries ?? [];
    const showHidden = useApp.getState().showHidden;
    const first = sortEntries(filterEntries(raw, { showHidden, filter: "" }), tab.view.sort)[0];
    navigateTo(selected.path, { select: first?.path ?? null });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!e.metaKey && !e.altKey && !e.ctrlKey && e.target === e.currentTarget) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        enterSelected();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (tab.path !== root) goUp();
        return;
      }
    }
    view.onKeyDown(e, LAYOUT);
  };

  return (
    <>
      <div
        ref={scrollRef}
        role="grid"
        aria-label="Files"
        aria-multiselectable
        aria-activedescendant={focusIndex >= 0 ? `${pane}-col-${focusIndex}` : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={view.onBackgroundMouseDown}
        onContextMenu={view.onBackgroundContextMenu}
        onScroll={view.onScroll}
        data-drop-dir={tab.path}
        style={{ width: COLUMN_WIDTH }}
        className="relative shrink-0 overflow-y-auto border-r border-border outline-none"
      >
        {body ?? (
          <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
            {virtualizer.getVirtualItems().map((v) => {
              const entry = entries[v.index];
              if (!entry) return null;
              return (
                <ColumnRow
                  key={entry.path}
                  id={`${pane}-col-${v.index}`}
                  entry={entry}
                  top={v.start}
                  selected={selection.paths.has(entry.path)}
                  renaming={renaming === entry.path}
                  dropTarget={dropTarget === entry.path}
                  onMouseDown={view.onItemMouseDown}
                  onDoubleClick={view.onItemDoubleClick}
                  onContextMenu={view.onItemContextMenu}
                />
              );
            })}
          </div>
        )}
      </div>
      {selected &&
        (isFolderLike(selected) ? (
          <ChildColumn pane={pane} path={selected.path} />
        ) : (
          <div style={{ width: PREVIEW_WIDTH }} className="flex shrink-0 flex-col border-r border-border">
            <EntryPreview key={selected.path} entry={selected} />
          </div>
        ))}
    </>
  );
}

/** Contents of the selected folder, listed once the selection rests. */
function ChildColumn({ pane, path }: { pane: PaneId; path: string }) {
  useEffect(() => {
    const t = setTimeout(() => ensureListed(path), CHILD_DELAY_MS);
    return () => clearTimeout(t);
  }, [path]);
  return <StaticColumn pane={pane} path={path} highlight={null} listed />;
}

/** A folder that isn't the focused one: clicking an item focuses this column on it. */
function StaticColumn({
  pane,
  path,
  highlight,
  listed = false,
}: {
  pane: PaneId;
  path: string;
  highlight: string | null;
  /** The caller takes care of listing the folder. */
  listed?: boolean;
}) {
  const sort = useActiveTab(pane).view.sort;
  const dir = useDirCache((s) => s.dirs[path]);
  const entries = useSortedEntries(path, sort);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dropTarget = useDrag((s) => s.target);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Ancestors keep their cached listing; they were current a moment ago.
  useEffect(() => {
    if (!listed && !useDirCache.getState().dirs[path]) ensureListed(path);
  }, [path, listed]);

  const highlightIndex = highlight ? entries.findIndex((e) => e.path === highlight) : -1;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll once the highlighted row exists
  useEffect(() => {
    if (highlightIndex >= 0) virtualizer.scrollToIndex(highlightIndex, { align: "center" });
  }, [highlightIndex]);

  const select = (entry: FileEntry) => navigateTo(path, { select: entry.path });

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={`Contents of ${path}`}
      data-drop-dir={path}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget || e.target === e.currentTarget.firstChild) navigateTo(path);
      }}
      style={{ width: COLUMN_WIDTH }}
      className="relative shrink-0 overflow-y-auto border-r border-border"
    >
      {statusBody(dir, entries, false) ?? (
        <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
          {virtualizer.getVirtualItems().map((v) => {
            const entry = entries[v.index];
            if (!entry) return null;
            return (
              <ColumnRow
                key={entry.path}
                entry={entry}
                top={v.start}
                selected={entry.path === highlight}
                renaming={false}
                dropTarget={dropTarget === entry.path}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  select(entry);
                  beginPotentialDrag(e, () => [entry.path]);
                }}
                onDoubleClick={() => void openEntries([entry])}
                onContextMenu={(e) => {
                  e.preventDefault();
                  select(entry);
                  void showItemMenu([entry]);
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

const ColumnRow = memo(function ColumnRow({
  id,
  entry,
  top,
  selected,
  renaming,
  dropTarget,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
}: {
  id?: string;
  entry: FileEntry;
  top: number;
  selected: boolean;
  renaming: boolean;
  dropTarget: boolean;
  onMouseDown: (e: React.MouseEvent, entry: FileEntry) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
}) {
  return (
    <div
      id={id}
      role="row"
      aria-selected={selected}
      data-selected={selected}
      data-drop-dir={dropDirFor(entry)}
      onMouseDown={(e) => onMouseDown(e, entry)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      className={`file-row absolute left-1 flex w-[calc(100%-8px)] items-center gap-1.5 rounded-[5px] px-1.5 text-[13px] ${
        entry.isHidden ? "opacity-60" : ""
      } ${dropTarget ? "ring-2 ring-accent ring-inset" : ""}`}
      style={{ top, height: ROW_HEIGHT }}
    >
      <FileIcon entry={entry} size={16} className="shrink-0" />
      {renaming ? (
        <RenameInput entry={entry} className="h-5 flex-1 text-[13px]" />
      ) : (
        <span role="gridcell" className="min-w-0 flex-1 truncate">
          {entry.name}
        </span>
      )}
      {isFolderLike(entry) && <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-60" />}
    </div>
  );
});
