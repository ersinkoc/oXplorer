import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { runJob } from "@/commands/jobs";
import { transferSpec } from "@/commands/locations";
import { currentFolder, navigateTo, selectedEntries, writableFolder } from "@/commands/navigation";
import { defineCommands } from "@/commands/registry";
import { toggleQuickLook } from "@/features/preview/quick-look";
import { t } from "@/i18n";
import { compareEntries, differences } from "@/lib/compare";
import { describeError, toAppError } from "@/lib/ipc";
import { isSearchPath } from "@/lib/search-path";
import { filterEntries } from "@/lib/sort";
import { useApp } from "@/stores/app-store";
import { useCompare } from "@/stores/compare-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { getActiveTab, otherPane, type PaneId, useWorkspace } from "@/stores/workspace-store";

function closeWindow(): void {
  void getCurrentWindow().close();
}

/** ⌘W: closes the tab; the last tab closes its pane, and the last pane the window. */
export function closeTab(pane: PaneId, id: string): void {
  const ws = useWorkspace.getState();
  if (ws.closeTab(pane, id)) return;
  if (!ws.dualPane) {
    closeWindow();
    return;
  }
  // Closing the left pane's last tab promotes the right pane.
  if (pane === "left") ws.swapPanes();
  useWorkspace.getState().setDualPane(false);
}

/** F5 / F6: copies or moves the selection into the other pane's folder. */
async function transferToOtherPane(kind: "copy" | "move"): Promise<void> {
  const { dualPane, activePane } = useWorkspace.getState();
  if (!dualPane) {
    toast(t("Open the second pane first (⌘U)."));
    return;
  }
  const sources = selectedEntries().map((e) => e.path);
  if (sources.length === 0) return;
  const destDir = writableFolder(otherPane(activePane));
  if (!destDir) return;
  const spec = transferSpec(sources, destDir, kind);
  if (spec) await runJob(spec);
}

export function registerTabCommands(): void {
  defineCommands([
    {
      id: "tab.new",
      title: "New Tab",
      run: () => {
        const { newTabLocation, home } = useApp.getState();
        useWorkspace.getState().openTab(newTabLocation === "home" ? home : getActiveTab().path);
      },
    },
    {
      id: "tab.close",
      title: "Close Tab",
      run: () => {
        const { activePane } = useWorkspace.getState();
        closeTab(activePane, getActiveTab().id);
      },
    },
    {
      id: "tab.openSelected",
      title: "Open in New Tab",
      run: () => {
        const ws = useWorkspace.getState();
        for (const e of selectedEntries()) {
          if (e.kind === "dir" || e.symlink?.targetIsDir) ws.openTab(e.path, { activate: false });
        }
      },
    },
    {
      id: "window.new",
      title: "New Window",
      run: async () => {
        // Windows start in a real folder; a search or server tab opens its folder (or Home).
        const r = await commands.openWindow(currentFolder());
        if (r.status === "error") toast.error(describeError(toAppError(r.error)));
      },
    },
    { id: "window.close", title: "Close Window", run: closeWindow },
    {
      id: "file.compareFiles",
      title: "Compare Files",
      run: () => {
        // Two files selected in this pane, or one in each pane.
        const { dualPane, activePane } = useWorkspace.getState();
        const isFile = (e: { kind: string }) => e.kind === "file";
        const here = selectedEntries().filter(isFile);
        const there = dualPane ? selectedEntries(otherPane(activePane)).filter(isFile) : [];
        const pair =
          here.length === 2
            ? [here[0], here[1]]
            : here.length === 1 && there.length === 1
              ? activePane === "left"
                ? [here[0], there[0]]
                : [there[0], here[0]]
              : null;
        const [a, b] = pair ?? [];
        if (!a || !b) {
          toast(t("Select two files, or one file in each pane."));
          return;
        }
        useApp.getState().set({ compareFiles: [a, b] });
      },
    },
    {
      id: "pane.syncBrowse",
      title: "Synchronized Browsing",
      run: () => {
        const { syncBrowse, set } = useApp.getState();
        if (!syncBrowse && !useWorkspace.getState().dualPane) useWorkspace.getState().setDualPane(true);
        set({ syncBrowse: !syncBrowse });
        toast(syncBrowse ? t("Synchronized browsing is off") : t("Synchronized browsing is on"));
      },
    },
    { id: "tab.next", title: "Show Next Tab", run: () => useWorkspace.getState().cycleTab(1) },
    { id: "tab.prev", title: "Show Previous Tab", run: () => useWorkspace.getState().cycleTab(-1) },
    {
      id: "tab.moveToOtherPane",
      title: "Move Tab to Other Pane",
      run: () => {
        const ws = useWorkspace.getState();
        const to = otherPane(ws.activePane);
        ws.moveTab(ws.activePane, getActiveTab().id, to, ws.panes[to].tabs.length);
      },
    },
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `tab.goto.${i + 1}`,
      title: `Show Tab ${i + 1}`,
      run: () => {
        const ws = useWorkspace.getState();
        const { tabs } = ws.panes[ws.activePane];
        // ⌥⌘9 is always the last tab, as in browsers.
        const tab = i === 8 ? tabs.at(-1) : tabs[i];
        if (tab) ws.activateTab(ws.activePane, tab.id);
      },
    })),

    {
      id: "pane.toggleDual",
      title: "Dual Pane",
      run: () => {
        const ws = useWorkspace.getState();
        if (ws.dualPane) return ws.setDualPane(false);
        ws.setDualPane(true);
        ws.setActivePane("right");
      },
    },
    {
      id: "pane.switch",
      title: "Switch to Other Pane",
      run: () => {
        const ws = useWorkspace.getState();
        if (ws.dualPane) ws.setActivePane(otherPane(ws.activePane));
      },
    },
    { id: "pane.swap", title: "Swap Panes", run: () => useWorkspace.getState().swapPanes() },
    {
      id: "pane.compare",
      title: "Compare Panes",
      run: () => {
        const ws = useWorkspace.getState();
        if (useCompare.getState().pair) return useCompare.setState({ pair: null });
        if (!ws.dualPane) {
          toast(t("Open the second pane first (⌘U)."));
          return;
        }
        const left = getActiveTab("left").path;
        const right = getActiveTab("right").path;
        if (isSearchPath(left) || isSearchPath(right)) return;
        useCompare.setState({ pair: { left, right } });
      },
    },
    {
      id: "pane.selectDifferences",
      title: "Select Differences",
      run: () => {
        const ws = useWorkspace.getState();
        const pair = useCompare.getState().pair;
        if (!pair || !ws.dualPane) return;
        const cache = useDirCache.getState().dirs;
        const { showHidden } = useApp.getState();
        const list = (p: string) => filterEntries(cache[p]?.entries ?? [], { showHidden, filter: "" });
        const marks = compareEntries(list(pair.left), list(pair.right))[ws.activePane];
        const names = differences(marks);
        const paths = (cache[getActiveTab().path]?.entries ?? [])
          .filter((e) => names.has(e.name))
          .map((e) => e.path);
        ws.setSelection({ paths: new Set(paths), anchor: paths[0] ?? null, focus: paths[0] ?? null });
      },
    },
    {
      id: "pane.openInOther",
      title: "Open in Other Pane",
      run: () => {
        const ws = useWorkspace.getState();
        const [first] = selectedEntries();
        const target =
          first && (first.kind === "dir" || first.symlink?.targetIsDir) ? first.path : getActiveTab().path;
        const to = otherPane(ws.activePane);
        ws.setDualPane(true);
        navigateTo(target, { pane: to });
      },
    },
    { id: "file.copyToOther", title: "Copy to Other Pane", run: () => transferToOtherPane("copy") },
    { id: "file.moveToOther", title: "Move to Other Pane", run: () => transferToOtherPane("move") },

    {
      id: "view.togglePreview",
      title: "Show Preview",
      run: () => {
        const ws = useWorkspace.getState();
        ws.setPreview({ visible: !ws.preview.visible });
      },
    },
    { id: "file.quickLook", title: "Quick Look", run: toggleQuickLook },
  ]);
}
