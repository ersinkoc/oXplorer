import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { commands } from "@/bindings";
import {
  currentFolder,
  goBack,
  goForward,
  goUp,
  navigateTo,
  openEntries,
  reload,
  selectedEntries,
} from "@/commands/navigation";
import { defineCommands, runCommand } from "@/commands/registry";
import { paneLayout } from "@/features/file-view/visible-order";
import { focusedTerminal } from "@/features/terminal/terminal-registry";
import { t, tn } from "@/i18n";
import { CommandError, describeError, unwrap } from "@/lib/ipc";
import { isSearchPath, isVirtualPath, searchPath } from "@/lib/search-path";
import { EMPTY_SELECTION, invert, selectAll } from "@/lib/selection";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { measureFolders } from "@/stores/folder-size-store";
import { getActiveTab, useWorkspace } from "@/stores/workspace-store";

function isTextInput(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

export function registerAppCommands(): void {
  defineCommands([
    { id: "nav.back", title: "Back", run: goBack },
    { id: "nav.forward", title: "Forward", run: goForward },
    { id: "nav.up", title: "Enclosing Folder", run: goUp },
    { id: "nav.home", title: "Home", run: () => navigateTo(useApp.getState().home) },
    { id: "nav.goToFolder", title: "Go to Folder…", run: () => useApp.getState().set({ editingPath: true }) },

    {
      id: "file.open",
      title: "Open",
      run: () => openEntries(selectedEntries()),
    },
    {
      id: "file.showPackageContents",
      title: "Show Package Contents",
      run: () => {
        const [first] = selectedEntries();
        if (first?.kind === "package") navigateTo(first.path);
      },
    },
    {
      id: "file.revealInFinder",
      title: "Show in Finder",
      run: async () => {
        const target = selectedEntries()[0]?.path ?? currentFolder();
        try {
          await unwrap(commands.revealInFinder(target));
        } catch (err) {
          toast.error(err instanceof CommandError ? err.message : t("Couldn’t show in Finder."));
        }
      },
    },
    {
      id: "file.copyPath",
      title: "Copy Path",
      run: async () => {
        const sel = selectedEntries().map((e) => e.path);
        const paths = sel.length > 0 ? sel : [currentFolder()];
        await writeText(paths.join("\n"));
        toast.success(tn(paths.length, "Path copied", "{count} paths copied"));
      },
    },

    {
      id: "edit.selectAll",
      title: "Select All",
      run: () => {
        // The menu owns ⌘A, so text fields need it forwarded explicitly.
        const el = document.activeElement;
        const terminal = focusedTerminal();
        if (terminal) terminal.term.selectAll();
        else if (isTextInput(el)) el.select();
        else
          useWorkspace
            .getState()
            .setSelection(selectAll(paneLayout(useWorkspace.getState().activePane).order));
      },
    },

    {
      id: "edit.deselectAll",
      title: "Deselect All",
      run: () => useWorkspace.getState().setSelection(EMPTY_SELECTION),
    },
    {
      id: "edit.invertSelection",
      title: "Invert Selection",
      run: () => {
        const { activePane, setSelection } = useWorkspace.getState();
        setSelection(invert(getActiveTab(activePane).selection, paneLayout(activePane).order));
      },
    },
    {
      id: "edit.selectMatching",
      title: "Select Matching…",
      run: () => useApp.getState().set({ selectMatching: "select" }),
    },

    { id: "view.asList", title: "as List", run: () => useWorkspace.getState().updateView({ mode: "list" }) },
    {
      id: "view.asIcons",
      title: "as Icons",
      run: () => useWorkspace.getState().updateView({ mode: "icons" }),
    },
    {
      id: "view.asColumns",
      title: "as Columns",
      run: () => useWorkspace.getState().updateView({ mode: "columns" }),
    },
    {
      id: "view.toggleHidden",
      title: "Show Hidden Files",
      run: () => {
        const { showHidden, setPreference } = useApp.getState();
        setPreference("showHidden", !showHidden);
      },
    },
    {
      id: "view.toggleSidebar",
      title: "Toggle Sidebar",
      run: () => {
        const { sidebarVisible, setPreference } = useApp.getState();
        setPreference("sidebarVisible", !sidebarVisible);
      },
    },
    { id: "view.reload", title: "Reload", run: reload },
    {
      id: "view.diskUsage",
      title: "Disk Usage…",
      run: () => {
        const [first] = selectedEntries();
        const folder = first && first.kind === "dir" ? first.path : currentFolder();
        useApp.getState().set({ diskUsagePath: folder });
      },
    },
    {
      id: "file.addToSidebar",
      title: "Add to Sidebar",
      run: () => {
        // A selected folder, or else the folder (or search) on screen.
        const [first] = selectedEntries();
        const path = first?.kind === "dir" ? first.path : getActiveTab().path;
        const { favorites, setPreference } = useApp.getState();
        if (favorites.includes(path)) return;
        setPreference("favorites", [...favorites, path]);
        toast.success(t("Added to the sidebar"));
      },
    },
    {
      id: "view.calculateSizes",
      title: "Calculate Folder Sizes",
      run: () => {
        // The selected folders, or every folder in view when none is selected.
        const selected = selectedEntries().filter((e) => e.kind === "dir");
        const { activePane } = useWorkspace.getState();
        const visible = new Set(paneLayout(activePane).order);
        const all = (useDirCache.getState().dirs[getActiveTab(activePane).path]?.entries ?? []).filter(
          (e) => e.kind === "dir" && visible.has(e.path),
        );
        const folders = (selected.length > 0 ? selected : all).filter((e) => !isVirtualPath(e.path));
        if (folders.length > 0) void measureFolders(folders.map((e) => e.path));
      },
    },
    {
      id: "app.settings",
      title: "Settings…",
      run: async () => {
        const r = await commands.openSettings();
        if (r.status === "error") toast.error(describeError(r.error));
      },
    },
    {
      id: "palette.open",
      title: "Command Palette…",
      run: () => useApp.getState().set({ paletteOpen: true }),
    },
    {
      id: "view.find",
      title: "Find",
      run: () => {
        // In search results ⌘F edits the search; elsewhere it filters the folder.
        const pane = useWorkspace.getState().activePane;
        const field =
          document.querySelector<HTMLInputElement>(`section[data-pane="${pane}"] [data-search-query]`) ??
          document.querySelector<HTMLInputElement>("[data-filter-input]");
        field?.focus();
        field?.select();
      },
    },
    {
      id: "search.open",
      title: "Search…",
      run: () => {
        const { path } = getActiveTab();
        if (isSearchPath(path)) return runCommand("view.find");
        navigateTo(
          searchPath({
            scope: path,
            query: "",
            mode: "name",
            caseSensitive: false,
            regex: false,
            includeHidden: false,
          }),
        );
      },
    },
  ]);
}
