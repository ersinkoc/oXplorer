/**
 * A 1px divider with a wider invisible grab area. Reports the pointer position
 * along its axis (viewport coordinates) while dragging; double-click resets.
 * A "vertical" splitter separates columns, a "horizontal" one rows.
 */
export function Splitter({
  label,
  value,
  orientation = "vertical",
  onDrag,
  onReset,
}: {
  label: string;
  /** Current position, 0–100, for assistive technology. */
  value: number;
  orientation?: "vertical" | "horizontal";
  onDrag: (client: number) => void;
  onReset: () => void;
}) {
  const vertical = orientation === "vertical";
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const move = (ev: MouseEvent) => onDrag(vertical ? ev.clientX : ev.clientY);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = vertical ? "col-resize" : "row-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't be dragged
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={-1}
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
      className={`relative z-10 shrink-0 bg-border before:absolute before:content-[''] ${
        vertical
          ? "w-px cursor-col-resize before:inset-y-0 before:-left-[3px] before:w-[7px]"
          : "h-px cursor-row-resize before:inset-x-0 before:-top-[3px] before:h-[7px]"
      }`}
    />
  );
}
