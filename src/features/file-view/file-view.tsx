import { FileGrid } from "@/features/file-view/file-grid";
import { FileList } from "@/features/file-view/file-list";
import { type PaneId, useActiveTab } from "@/stores/workspace-store";

export function FileView({ pane }: { pane: PaneId }) {
  const mode = useActiveTab(pane).view.mode;
  return mode === "icons" ? <FileGrid pane={pane} /> : <FileList pane={pane} />;
}
