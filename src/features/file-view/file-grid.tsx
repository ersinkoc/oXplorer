import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useEffect, useState } from "react";
import type { GitState } from "@/bindings";
import { useDrag } from "@/features/dnd/drag-store";
import { dropDirFor } from "@/features/dnd/drop-target";
import { CompareStripe } from "@/features/file-view/compare-stripe";
import { FileIcon } from "@/features/file-view/file-icon";
import { GitBadge } from "@/features/file-view/git-badge";
import { RenameInput } from "@/features/file-view/rename-input";
import { TagDots } from "@/features/file-view/tag-dots";
import { useFileView } from "@/features/file-view/use-file-view";
import { statusBody } from "@/features/file-view/view-states";
import { useT } from "@/i18n";
import type { CompareMark } from "@/lib/compare";
import type { FileEntry } from "@/lib/ipc";
import { isVirtualPath } from "@/lib/search-path";
import { useCompareMarks } from "@/stores/compare-store";
import { useGitStates } from "@/stores/git-store";
import type { PaneId } from "@/stores/workspace-store";

const CELL_WIDTH = 104;
const CELL_HEIGHT = 112;
const ICON = 64;
const PADDING = 12;

/** Icon view: virtualized by rows, column count follows the pane width. */
export function FileGrid({ pane }: { pane: PaneId }) {
  const { t } = useT();
  const [width, setWidth] = useState(0);
  const columns = Math.max(1, Math.floor((width - PADDING * 2) / CELL_WIDTH));
  const view = useFileView(pane, columns, (i) =>
    virtualizer.scrollToIndex(Math.floor(i / columns), { align: "auto" }),
  );
  const { tab, dir, entries, selection, scrollRef, focusIndex, renaming } = view;
  const git = useGitStates(tab.path);
  const compare = useCompareMarks(pane);
  const dropTarget = useDrag((s) => s.target);
  const rows = Math.ceil(entries.length / columns);

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CELL_HEIGHT,
    overscan: 4,
    paddingStart: PADDING,
    paddingEnd: PADDING,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef]);

  const body = statusBody(dir, entries, !!tab.view.filter);

  return (
    <div className="file-list flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="grid"
        aria-label={t("Files")}
        aria-multiselectable
        aria-activedescendant={focusIndex >= 0 ? cellId(pane, focusIndex) : undefined}
        tabIndex={0}
        onKeyDown={(e) => view.onKeyDown(e, { columns, rowHeight: CELL_HEIGHT })}
        onMouseDown={view.onBackgroundMouseDown}
        onContextMenu={view.onBackgroundContextMenu}
        onScroll={view.onScroll}
        data-drop-dir={isVirtualPath(tab.path) ? undefined : tab.path}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none [contain:strict]"
      >
        {body ?? (
          <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.index}
                role="row"
                className="absolute flex"
                style={{ top: row.start, left: PADDING, height: CELL_HEIGHT }}
              >
                {entries.slice(row.index * columns, row.index * columns + columns).map((entry, col) => {
                  const index = row.index * columns + col;
                  return (
                    <Cell
                      key={entry.path}
                      id={cellId(pane, index)}
                      entry={entry}
                      selected={selection.paths.has(entry.path)}
                      renaming={renaming === entry.path}
                      dropTarget={dropTarget === entry.path}
                      git={git?.get(entry.name)}
                      compare={compare?.get(entry.name)}
                      onMouseDown={view.onItemMouseDown}
                      onDoubleClick={view.onItemDoubleClick}
                      onContextMenu={view.onItemContextMenu}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function cellId(pane: PaneId, index: number): string {
  return `${pane}-cell-${index}`;
}

const Cell = memo(function Cell({
  id,
  entry,
  selected,
  renaming,
  dropTarget,
  git,
  compare,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
}: {
  id: string;
  entry: FileEntry;
  selected: boolean;
  renaming: boolean;
  dropTarget: boolean;
  git?: GitState;
  compare?: CompareMark;
  onMouseDown: (e: React.MouseEvent, entry: FileEntry) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
}) {
  return (
    <div
      id={id}
      role="gridcell"
      aria-selected={selected}
      data-selected={selected}
      data-drop-dir={dropDirFor(entry)}
      onMouseDown={(e) => onMouseDown(e, entry)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      className={`grid-cell relative flex flex-col items-center gap-1 rounded-md px-1 pt-2 ${
        entry.isHidden || git === "ignored" ? "opacity-60" : ""
      } ${dropTarget ? "ring-2 ring-accent ring-inset" : ""}`}
      style={{ width: CELL_WIDTH, height: CELL_HEIGHT }}
    >
      <CompareStripe mark={compare} />
      <div className="grid-cell-icon flex items-center justify-center rounded-md p-1">
        <FileIcon entry={entry} size={ICON} thumbnail />
      </div>
      <div className="flex max-w-full items-start">
        {renaming ? (
          <RenameInput entry={entry} className="w-full text-center text-[12px]" />
        ) : (
          <span className="grid-cell-name line-clamp-2 rounded px-1 text-center text-[12px] leading-[15px] break-words">
            {entry.name}
          </span>
        )}
        <TagDots tags={entry.tags} />
        <GitBadge state={git} />
      </div>
    </div>
  );
});
