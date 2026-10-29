import { Menu } from "@tauri-apps/api/menu";
import { ChevronDown, ChevronUp } from "lucide-react";
import { msg, t as translate, useT } from "@/i18n";
import { nextSort, type SortConfig, type SortField } from "@/lib/sort";
import { type ColumnWidths, LIST_COLUMNS, type ListColumn, useApp } from "@/stores/app-store";

const LABELS: Record<SortField, string> = {
  name: msg("Name"),
  modified: msg("Date Modified"),
  created: msg("Date Created"),
  size: msg("Size"),
  kind: msg("Kind"),
};

const MIN_WIDTH = 60;
const DEFAULT_WIDTH = 150;

/** The columns to show, in display order (a stored list may be stale). Search
 * results always keep the last column: it says where each item was found. */
export function visibleColumns(chosen: readonly string[], search = false): ListColumn[] {
  return LIST_COLUMNS.filter((c) => chosen.includes(c) || (search && c === "kind"));
}

export function columnWidth(w: ColumnWidths, c: ListColumn): number {
  return w[c] ?? DEFAULT_WIDTH;
}

export function gridTemplate(w: ColumnWidths, columns: readonly ListColumn[]): string {
  return ["minmax(180px, 1fr)", ...columns.map((c) => `${columnWidth(w, c)}px`)].join(" ");
}

/** Right-click on the header: which columns to show, like Finder's. */
async function showColumnsMenu(): Promise<void> {
  const shown = visibleColumns(useApp.getState().listColumns);
  const menu = await Menu.new({
    items: LIST_COLUMNS.map((c) => ({
      text: translate(LABELS[c]),
      checked: shown.includes(c),
      action: () => {
        const next = shown.includes(c) ? shown.filter((x) => x !== c) : [...shown, c];
        useApp.getState().setPreference("listColumns", visibleColumns(next));
      },
    })),
  });
  await menu.popup();
}

export function ListHeader({
  columns,
  sort,
  onSort,
  kindLabel,
}: {
  columns: readonly ListColumn[];
  sort: SortConfig;
  onSort: (s: SortConfig) => void;
  /** Replaces "Kind" when the last column shows something else (search results). */
  kindLabel?: string;
}) {
  const { t } = useT();
  const widths = useApp((s) => s.columnWidths);

  const startResize = (key: ListColumn, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = columnWidth(widths, key);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      // Handles sit on a column's left edge, so dragging left widens it.
      latest = Math.max(MIN_WIDTH, Math.round(startW - (ev.clientX - startX)));
      useApp.getState().set({ columnWidths: { ...useApp.getState().columnWidths, [key]: latest } });
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove as EventListener);
      target.removeEventListener("pointerup", onUp);
      useApp.getState().setPreference("columnWidths", { ...useApp.getState().columnWidths, [key]: latest });
    };
    target.addEventListener("pointermove", onMove as EventListener);
    target.addEventListener("pointerup", onUp);
  };

  return (
    <div
      role="row"
      className="grid h-[26px] shrink-0 border-b border-border bg-bg text-[12px] text-fg-muted"
      style={{ gridTemplateColumns: gridTemplate(widths, columns) }}
      onContextMenu={(e) => {
        e.preventDefault();
        void showColumnsMenu();
      }}
    >
      {(["name", ...columns] as const).map((field) => {
        const active = sort.field === field;
        const Arrow = sort.direction === "asc" ? ChevronUp : ChevronDown;
        return (
          <div
            key={field}
            role="columnheader"
            aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
            className="relative flex min-w-0"
          >
            {field !== "name" && (
              <div
                aria-hidden
                onPointerDown={(e) => startResize(field, e)}
                className="absolute inset-y-1 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border"
              />
            )}
            <button
              type="button"
              onClick={() => onSort(nextSort(sort, field))}
              className={`flex min-w-0 flex-1 items-center gap-1 px-2.5 hover:bg-hover ${
                field === "size" ? "justify-end" : ""
              } ${active ? "font-semibold text-fg" : ""}`}
            >
              <span className="truncate">{field === "kind" && kindLabel ? kindLabel : t(LABELS[field])}</span>
              {active && <Arrow className="size-3 shrink-0" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
