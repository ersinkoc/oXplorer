import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { commands } from "@/bindings";
import { runJob } from "@/commands/jobs";
import { useDrag } from "@/features/dnd/drag-store";
import { dropDirAt, dropMode, isValidDrop, terminalAt } from "@/features/dnd/drop-target";
import { pasteInto } from "@/features/terminal/terminal-registry";
import { isArchivePath } from "@/lib/archive-path";
import { shellArgs } from "@/lib/shell";

const THRESHOLD = 5;

/**
 * Pointer-driven drag for items inside the window. Leaving the window hands the
 * drag over to a native session so items can be dropped into Finder or other apps.
 *
 * `onClick` runs if the pointer is released without dragging (Finder collapses a
 * multi-selection to the clicked item only then, not on mouse-down).
 */
export function beginPotentialDrag(
  e: React.MouseEvent,
  getPaths: () => string[],
  onClick?: () => void,
): void {
  const startX = e.clientX;
  const startY = e.clientY;
  let dragging = false;
  let paths: string[] = [];
  let preview: Promise<string | null> = Promise.resolve(null);

  const cleanup = () => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    useDrag.setState({ active: false, target: null });
  };

  const onMove = (ev: MouseEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      paths = getPaths();
      if (paths.length === 0) return cleanup();
      dragging = true;
      const [first] = paths;
      preview = first
        ? commands.dragPreview(first).then((r) => (r.status === "ok" ? r.data : null))
        : preview;
    }
    const outside =
      ev.clientX < 0 || ev.clientY < 0 || ev.clientX > window.innerWidth || ev.clientY > window.innerHeight;
    if (outside) {
      cleanup();
      if (paths.some(isArchivePath)) return;
      void preview.then((icon) => {
        if (icon) void startDrag({ item: paths, icon, mode: ev.altKey ? "copy" : "move" });
      });
      return;
    }
    const dir = dropDirAt(ev.clientX, ev.clientY);
    const target = dir && isValidDrop(paths, dir) ? dir : null;
    useDrag.setState({
      active: true,
      count: paths.length,
      x: ev.clientX,
      y: ev.clientY,
      target,
      copy: ev.altKey,
    });
  };

  const onUp = (ev: MouseEvent) => {
    const { target } = useDrag.getState();
    cleanup();
    if (!dragging) {
      onClick?.();
      return;
    }
    // Dropped on a terminal: type the quoted paths, like Terminal.app.
    const terminal = terminalAt(ev.clientX, ev.clientY);
    if (terminal) {
      if (!paths.some(isArchivePath)) pasteInto(terminal, shellArgs(paths));
      return;
    }
    if (target) {
      // Items dragged out of an archive are extracted there; the archive stays as it is.
      if (paths.some(isArchivePath)) {
        void runJob({ kind: "extractMembers", sources: paths, destDir: target }, { select: false });
        return;
      }
      const kind = dropMode(paths, target, ev.altKey);
      void runJob({ kind, sources: paths, destDir: target }, { select: false });
    }
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      dragging = false;
      cleanup();
    }
  };

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
  window.addEventListener("keydown", onKey, true);
}
