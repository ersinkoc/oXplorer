/**
 * A 1px divider with a wider invisible grab area. Reports the pointer's x in
 * viewport coordinates while dragging; double-click resets.
 */
export function Splitter({
  label,
  value,
  onDrag,
  onReset,
}: {
  label: string;
  /** Current position, 0–100, for assistive technology. */
  value: number;
  onDrag: (clientX: number) => void;
  onReset: () => void;
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const move = (ev: MouseEvent) => onDrag(ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't be dragged
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={-1}
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
      className="relative z-10 w-px shrink-0 cursor-col-resize bg-border before:absolute before:inset-y-0 before:-left-[3px] before:w-[7px] before:content-['']"
    />
  );
}
