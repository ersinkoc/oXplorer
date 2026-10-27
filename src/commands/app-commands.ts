import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import { commands } from "@/bindings";
import {
  goBack,
  goForward,
  goUp,
  navigateTo,
  openEntries,
  reload,
  selectedEntries,
} from "@/commands/navigation";
import { defineCommands } from "@/commands/registry";
import { paneLayout } from "@/features/file-view/visible-order";
import { CommandError, unwrap } from "@/lib/ipc";
import { selectAll } from "@/lib/selection";
import { useApp } from "@/stores/app-store";
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
      id: "file.revealInFinder",
      title: "Show in Finder",
      run: async () => {
        const target = selectedEntries()[0]?.path ?? getActiveTab().path;
        try {
          await unwrap(commands.revealInFinder(target));
        } catch (err) {
          toast.error(err instanceof CommandError ? err.message : "Couldn’t show in Finder.");
        }
      },
    },
    {
      id: "file.copyPath",
      title: "Copy Path",
      run: async () => {
        const sel = selectedEntries().map((e) => e.path);
        const paths = sel.length > 0 ? sel : [getActiveTab().path];
        await writeText(paths.join("\n"));
        toast.success(paths.length === 1 ? "Path copied" : `${paths.length} paths copied`);
      },
    },

    {
      id: "edit.selectAll",
      title: "Select All",
      run: () => {
        // The menu owns ⌘A, so text fields need it forwarded explicitly.
        const el = document.activeElement;
        if (isTextInput(el)) el.select();
        else
          useWorkspace
            .getState()
            .setSelection(selectAll(paneLayout(useWorkspace.getState().activePane).order));
      },
    },

    { id: "view.asList", title: "as List", run: () => useWorkspace.getState().updateView({ mode: "list" }) },
    {
      id: "view.asIcons",
      title: "as Icons",
      run: () => useWorkspace.getState().updateView({ mode: "icons" }),
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
  ]);
}
