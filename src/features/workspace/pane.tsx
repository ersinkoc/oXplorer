import { useEffect } from "react";
import { ensureListed } from "@/commands/navigation";
import { FileView } from "@/features/file-view/file-view";
import { SearchHeader } from "@/features/search/search-header";
import { StatusBar } from "@/features/status/status-bar";
import { TabBar } from "@/features/workspace/tab-bar";
import { useT } from "@/i18n";
import { isArchivePath } from "@/lib/archive-path";
import { isRemotePath } from "@/lib/remote-path";
import { isSearchPath } from "@/lib/search-path";
import { useDirCache } from "@/stores/dir-cache-store";
import { refreshGit } from "@/stores/git-store";
import { recordVisit } from "@/stores/recents-store";
import { type PaneId, useActiveTab, useWorkspace } from "@/stores/workspace-store";

/** One side of the workspace: its tabs, the active tab's folder and a status bar. */
export function Pane({ pane, style }: { pane: PaneId; style?: React.CSSProperties }) {
  const { t } = useT();
  const path = useActiveTab(pane).path;
  const dual = useWorkspace((s) => s.dualPane);
  const tabCount = useWorkspace((s) => s.panes[pane].tabs.length);

  // A folder is (re)listed whenever a pane starts showing it: watches only cover
  // visible folders, so a cached listing may be stale.
  useEffect(() => {
    if (isArchivePath(path) || isRemotePath(path)) return ensureListed(path);
    if (!isSearchPath(path)) {
      recordVisit(path);
      refreshGit(path, true);
      return ensureListed(path);
    }
    // Searches run once; switching back to the tab shows the same results.
    if (!useDirCache.getState().dirs[path]) void useDirCache.getState().load(path);
    return () => useDirCache.getState().stop(path);
  }, [path]);

  const activate = () => useWorkspace.getState().setActivePane(pane);

  return (
    <section
      aria-label={pane === "left" ? t("Left pane") : t("Right pane")}
      data-pane={pane}
      onMouseDownCapture={activate}
      onFocusCapture={activate}
      style={style}
      className="flex min-w-0 flex-col"
    >
      {(dual || tabCount > 1) && <TabBar pane={pane} />}
      {isSearchPath(path) && <SearchHeader key={path} pane={pane} path={path} />}
      <FileView pane={pane} />
      <StatusBar pane={pane} />
    </section>
  );
}
