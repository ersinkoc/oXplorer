import { ChevronDown, ChevronUp } from "lucide-react";
import { msg, useT } from "@/i18n";
import { nextSort, type SortConfig, type SortField } from "@/lib/sort";
import { type ColumnWidths, useApp } from "@/stores/app-store";

const COLUMNS: { field: SortField; label: string; width?: keyof ColumnWidths; align?: "right" }[] = [
  { field: "name", label: msg("Name") },
  { field: "modified", label: msg("Date Modified"), width: "modified" },
  { field: "size", label: msg("Size"), width: "size", align: "right" },
  { field: "kind", label: msg("Kind"), width: "kind" },
];

const MIN_WIDTH = 60;

export function gridTemplate(w: ColumnWidths): string {
  return `minmax(180px, 1fr) ${w.modified}px ${w.size}px ${w.kind}px`;
}

export function ListHeader({
  sort,
  onSort,
  kindLabel,
}: {
  sort: SortConfig;
  onSort: (s: SortConfig) => void;
  /** Replaces "Kind" when the last column shows something else (search results). */
  kindLabel?: string;
}) {
  const { t } = useT();
  const widths = useApp((s) => s.columnWidths);

  const startResize = (key: keyof ColumnWidths, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[key];
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
      style={{ gridTemplateColumns: gridTemplate(widths) }}
    >
      {COLUMNS.map((col) => {
        const active = sort.field === col.field;
        const Arrow = sort.direction === "asc" ? ChevronUp : ChevronDown;
        return (
          <div
            key={col.field}
            role="columnheader"
            aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
            className="relative flex min-w-0"
          >
            {col.width && (
              <div
                aria-hidden
                onPointerDown={(e) => col.width && startResize(col.width, e)}
                className="absolute inset-y-1 left-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-border"
              />
            )}
            <button
              type="button"
              onClick={() => onSort(nextSort(sort, col.field))}
              className={`flex min-w-0 flex-1 items-center gap-1 px-2.5 hover:bg-hover ${
                col.align === "right" ? "justify-end" : ""
              } ${active ? "font-semibold text-fg" : ""}`}
            >
              <span className="truncate">{col.field === "kind" && kindLabel ? kindLabel : t(col.label)}</span>
              {active && <Arrow className="size-3 shrink-0" />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
