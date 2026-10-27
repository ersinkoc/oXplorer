import { useEffect } from "react";
import { ensureListed } from "@/commands/navigation";
import { FileView } from "@/features/file-view/file-view";
import { StatusBar } from "@/features/status/status-bar";
import { TabBar } from "@/features/workspace/tab-bar";
import { type PaneId, useActiveTab, useWorkspace } from "@/stores/workspace-store";

/** One side of the workspace: its tabs, the active tab's folder and a status bar. */
export function Pane({ pane, style }: { pane: PaneId; style?: React.CSSProperties }) {
  const path = useActiveTab(pane).path;
  const dual = useWorkspace((s) => s.dualPane);
  const tabCount = useWorkspace((s) => s.panes[pane].tabs.length);

  // A folder is (re)listed whenever a pane starts showing it: watches only cover
  // visible folders, so a cached listing may be stale.
  useEffect(() => ensureListed(path), [path]);

  const activate = () => useWorkspace.getState().setActivePane(pane);

  return (
    <section
      aria-label={pane === "left" ? "Left pane" : "Right pane"}
      onMouseDownCapture={activate}
      onFocusCapture={activate}
      style={style}
      className="flex min-w-0 flex-col"
    >
      {(dual || tabCount > 1) && <TabBar pane={pane} />}
      <FileView pane={pane} />
      <StatusBar pane={pane} />
    </section>
  );
}
