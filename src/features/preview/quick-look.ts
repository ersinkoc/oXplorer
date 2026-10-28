import { commands, events } from "@/bindings";
import { materialize } from "@/commands/locations";
import { paneLayout } from "@/features/file-view/visible-order";
import { move } from "@/lib/selection";
import { getActiveTab, useWorkspace } from "@/stores/workspace-store";

let visible = false;

/** Selected paths of the active pane in on-screen order, and the focused one's index. */
function currentItems(): { paths: string[]; index: number } {
  const { activePane } = useWorkspace.getState();
  const { selection } = getActiveTab();
  const paths = paneLayout(activePane).order.filter((p) => selection.paths.has(p));
  return { paths, index: Math.max(0, selection.focus ? paths.indexOf(selection.focus) : 0) };
}

/** Space / ⌘Y: opens the system Quick Look panel on the selection, or closes it. */
export function toggleQuickLook(): void {
  if (visible) {
    void commands.quickLookClose();
    return;
  }
  const { paths, index } = currentItems();
  if (paths.length > 0) void realPaths(paths).then((real) => commands.quickLook(real, index, true));
}

/** Items inside an archive or on a server are copied to a temporary folder for Quick Look. */
async function realPaths(paths: readonly string[]): Promise<string[]> {
  return Promise.all(paths.map((p) => materialize(p).catch(() => p)));
}

/**
 * While the panel is open it follows the selection, and arrow keys pressed in
 * the panel move the selection in the active pane (as in Finder).
 */
export function installQuickLook(): () => void {
  const unsubscribe = useWorkspace.subscribe((s, prev) => {
    if (!visible) return;
    const pane = s.activePane;
    if (s.panes[pane] === prev.panes[pane] && pane === prev.activePane) return;
    const { paths, index } = currentItems();
    if (paths.length > 0) void realPaths(paths).then((real) => commands.quickLook(real, index, false));
  });
  const unlistenState = events.quickLookState.listen((e) => {
    visible = e.payload.visible;
  });
  const unlistenKey = events.quickLookKey.listen(({ payload }) => {
    const { activePane, setSelection } = useWorkspace.getState();
    const { order, columns } = paneLayout(activePane);
    const deltas: Record<string, number> = {
      ArrowDown: columns,
      ArrowUp: -columns,
      ArrowLeft: -1,
      ArrowRight: 1,
    };
    const horizontal = payload.key === "ArrowLeft" || payload.key === "ArrowRight";
    const delta = deltas[payload.key];
    // A list has no left/right neighbors.
    if (delta === undefined || (columns === 1 && horizontal)) return;
    setSelection(move(getActiveTab().selection, order, delta, payload.shift));
  });
  return () => {
    unsubscribe();
    void unlistenState.then((fn) => fn());
    void unlistenKey.then((fn) => fn());
  };
}
