import { Copy, Files } from "lucide-react";
import { useDrag } from "@/features/dnd/drag-store";
import { useT } from "@/i18n";

/** Follows the pointer during an in-app drag. */
export function DragGhost() {
  const { tn } = useT();
  const { active, count, x, y, copy, target } = useDrag();
  if (!active) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-md bg-accent px-2 py-1 text-[12px] font-medium text-white shadow-lg"
      style={{ left: x + 12, top: y + 12, opacity: target ? 1 : 0.75 }}
    >
      {copy ? <Copy className="size-3.5" /> : <Files className="size-3.5" />}
      {tn(count, "{count} item", "{count} items")}
    </div>
  );
}
