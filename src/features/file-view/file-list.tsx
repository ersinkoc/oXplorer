import { useVirtualizer } from "@tanstack/react-virtual";
import { memo } from "react";
import { useDrag } from "@/features/dnd/drag-store";
import { dropDirFor } from "@/features/dnd/drop-target";
import { FileIcon } from "@/features/file-view/file-icon";
import { gridTemplate, ListHeader } from "@/features/file-view/list-header";
import { RenameInput } from "@/features/file-view/rename-input";
import { TagDots } from "@/features/file-view/tag-dots";
import { useFileView } from "@/features/file-view/use-file-view";
import { statusBody } from "@/features/file-view/view-states";
import { entrySizeLabel, formatDate, kindLabel } from "@/lib/format";
import type { FileEntry } from "@/lib/ipc";
import { useApp } from "@/stores/app-store";
import { type PaneId, useWorkspace } from "@/stores/workspace-store";

const ROW_HEIGHT = 24;
const LAYOUT = { columns: 1, rowHeight: ROW_HEIGHT };

export function FileList({ pane }: { pane: PaneId }) {
  const widths = useApp((s) => s.columnWidths);
  const view = useFileView(pane, 1, (i) => virtualizer.scrollToIndex(i, { align: "auto" }));
  const { tab, dir, entries, selection, scrollRef, focusIndex, renaming } = view;
  const dropTarget = useDrag((s) => s.target);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  const body = statusBody(dir, entries, !!tab.view.filter);

  return (
    <div
      className="file-list flex min-h-0 flex-1 flex-col"
      style={{ ["--grid" as string]: gridTemplate(widths) }}
    >
      <ListHeader
        sort={tab.view.sort}
        onSort={(sort) => useWorkspace.getState().updateView({ sort }, pane)}
      />
      <div
        ref={scrollRef}
        role="grid"
        aria-label="Files"
        aria-rowcount={entries.length}
        aria-multiselectable
        aria-activedescendant={focusIndex >= 0 ? rowId(pane, focusIndex) : undefined}
        tabIndex={0}
        onKeyDown={(e) => view.onKeyDown(e, LAYOUT)}
        onMouseDown={view.onBackgroundMouseDown}
        onContextMenu={view.onBackgroundContextMenu}
        onScroll={view.onScroll}
        data-drop-dir={tab.path}
        className="relative min-h-0 flex-1 overflow-y-auto outline-none [contain:strict]"
      >
        {body ?? (
          <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
            {virtualizer.getVirtualItems().map((v) => {
              const entry = entries[v.index];
              if (!entry) return null;
              return (
                <Row
                  key={entry.path}
                  id={rowId(pane, v.index)}
                  entry={entry}
                  index={v.index}
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
    </div>
  );
}

function rowId(pane: PaneId, index: number): string {
  return `${pane}-row-${index}`;
}

const Row = memo(function Row({
  id,
  entry,
  index,
  top,
  selected,
  renaming,
  dropTarget,
  onMouseDown,
  onDoubleClick,
  onContextMenu,
}: {
  id: string;
  entry: FileEntry;
  index: number;
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
      aria-rowindex={index + 1}
      aria-selected={selected}
      data-selected={selected}
      data-drop-dir={dropDirFor(entry)}
      onMouseDown={(e) => onMouseDown(e, entry)}
      onDoubleClick={() => onDoubleClick(entry)}
      onContextMenu={(e) => onContextMenu(e, entry)}
      className={`file-row absolute left-0 grid w-full items-center rounded-[5px] text-[13px] ${
        index % 2 === 1 ? "bg-bg-alt" : ""
      } ${entry.isHidden ? "opacity-60" : ""} ${dropTarget ? "ring-2 ring-accent ring-inset" : ""}`}
      style={{ top, height: ROW_HEIGHT, gridTemplateColumns: "var(--grid)" }}
    >
      <div role="gridcell" className="flex min-w-0 items-center gap-1.5 px-2.5">
        <FileIcon entry={entry} size={16} className="shrink-0" />
        {renaming ? (
          <RenameInput entry={entry} className="h-5 flex-1 text-[13px]" />
        ) : (
          <span className="truncate">{entry.name}</span>
        )}
        <TagDots tags={entry.tags} />
      </div>
      <div role="gridcell" className="file-row-muted truncate px-2.5 text-fg-muted">
        {formatDate(entry.modifiedMs)}
      </div>
      <div role="gridcell" className="file-row-muted truncate px-2.5 text-right text-fg-muted tabular-nums">
        {entrySizeLabel(entry)}
      </div>
      <div role="gridcell" className="file-row-muted truncate px-2.5 text-fg-muted">
        {kindLabel(entry)}
      </div>
    </div>
  );
});
