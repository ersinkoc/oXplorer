import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { version as osVersion } from "@tauri-apps/plugin-os";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { defineCommands } from "@/commands/registry";
import { checkForUpdates } from "@/features/help/updates";
import { describeError } from "@/lib/ipc";
import { useApp } from "@/stores/app-store";

const ISSUES = "https://github.com/ersinkoc/oXplorer/issues/new";

export function registerHelpCommands(): void {
  defineCommands([
    { id: "app.checkUpdates", title: "Check for Updates…", run: () => checkForUpdates(true) },
    {
      id: "help.whatsNew",
      title: "What’s New in OXplorer",
      run: () => useApp.getState().set({ whatsNewOpen: true }),
    },
    {
      id: "help.report",
      title: "Report a Problem…",
      run: async () => {
        // Only versions go into the URL; the log has paths, so the user attaches it.
        const params = new URLSearchParams({
          template: "bug_report.yml",
          version: await getVersion(),
          macos: osVersion(),
        });
        await openUrl(`${ISSUES}?${params.toString()}`);
      },
    },
    {
      id: "help.showLog",
      title: "Show Log File",
      run: async () => {
        const log = await commands.logFile();
        if (log.status === "error") return void toast.error(describeError(log.error));
        const shown = await commands.revealInFinder(log.data);
        if (shown.status === "error") toast.error(describeError(shown.error));
      },
    },
  ]);
}
