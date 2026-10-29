import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { commands } from "@/bindings";
import { runJob } from "@/commands/jobs";
import { transferSpec } from "@/commands/locations";
import { navigateTo } from "@/commands/navigation";
import { FAVORITES_TARGET, useDrag } from "@/features/dnd/drag-store";
import {
  dropDirAt,
  dropMode,
  favoritesZoneAt,
  isValidDrop,
  localFolders,
  springTargetAt,
  terminalAt,
} from "@/features/dnd/drop-target";
import { pasteInto } from "@/features/terminal/terminal-registry";
import { isArchivePath } from "@/lib/archive-path";
import { isRemotePath } from "@/lib/remote-path";
import { shellArgs } from "@/lib/shell";
import { useApp } from "@/stores/app-store";
import { getActiveTab } from "@/stores/workspace-store";

const THRESHOLD = 5;
/** Hovering a folder this long during a drag opens it (Finder's spring-loaded folders). */
const SPRING_MS = 800;

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
  let spring: { key: string; timer: number } | null = null;

  const stopSpring = () => {
    if (spring) window.clearTimeout(spring.timer);
    spring = null;
  };

  /** Restarts the spring timer whenever the pointer moves to another folder. */
  const updateSpring = (x: number, y: number) => {
    const hit = springTargetAt(x, y);
    const shown = hit && getActiveTab(hit.pane).path;
    // Not the folder already shown, nor one it's inside (column view shows those too).
    const springs =
      hit && shown && hit.dir !== shown && !shown.startsWith(`${hit.dir}/`) && isValidDrop(paths, hit.dir);
    const key = springs ? `${hit.pane}\n${hit.dir}` : null;
    if (key === spring?.key) return;
    stopSpring();
    if (!hit || !key) return;
    spring = {
      key,
      timer: window.setTimeout(() => {
        spring = null;
        navigateTo(hit.dir, { pane: hit.pane });
      }, SPRING_MS),
    };
  };

  const cleanup = () => {
    stopSpring();
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
      if (paths.some((p) => isArchivePath(p) || isRemotePath(p))) return;
      void preview.then((icon) => {
        if (icon) void startDrag({ item: paths, icon, mode: ev.altKey ? "copy" : "move" });
      });
      return;
    }
    const dir = dropDirAt(ev.clientX, ev.clientY);
    const target =
      dir && isValidDrop(paths, dir)
        ? dir
        : !dir && favoritesZoneAt(ev.clientX, ev.clientY) && localFolders(paths).length > 0
          ? FAVORITES_TARGET
          : null;
    updateSpring(ev.clientX, ev.clientY);
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
      if (!paths.some((p) => isArchivePath(p) || isRemotePath(p))) pasteInto(terminal, shellArgs(paths));
      return;
    }
    if (target === FAVORITES_TARGET) {
      const { favorites, setPreference } = useApp.getState();
      const added = localFolders(paths).filter((p) => !favorites.includes(p));
      if (added.length > 0) setPreference("favorites", [...favorites, ...added]);
      return;
    }
    if (target) {
      const spec = transferSpec(paths, target, dropMode(paths, target, ev.altKey));
      if (spec) void runJob(spec, { select: false });
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
