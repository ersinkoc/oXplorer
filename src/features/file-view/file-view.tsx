import { FileColumns } from "@/features/file-view/file-columns";
import { FileGrid } from "@/features/file-view/file-grid";
import { FileList } from "@/features/file-view/file-list";
import { isSearchPath } from "@/lib/search-path";
import { type PaneId, useActiveTab } from "@/stores/workspace-store";

export function FileView({ pane }: { pane: PaneId }) {
  const { mode } = useActiveTab(pane).view;
  const search = isSearchPath(useActiveTab(pane).path);
  if (mode === "icons") return <FileGrid pane={pane} />;
  // Results come from many folders: columns would be meaningless.
  if (mode === "columns" && !search) return <FileColumns pane={pane} />;
  return <FileList pane={pane} />;
}
