import { listen } from "@tauri-apps/api/event";
import { info, error as logError } from "@tauri-apps/plugin-log";
import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { commands, events } from "@/bindings";
import { registerAppCommands } from "@/commands/app-commands";
import { registerFileCommands } from "@/commands/file-commands";
import { registerHelpCommands } from "@/commands/help-commands";
import { installGlobalKeys } from "@/commands/keymap";
import { openExternalPaths } from "@/commands/navigation";
import { listenToMenu } from "@/commands/registry";
import { registerTabCommands } from "@/commands/tab-commands";
import { openTerminal, registerTerminalCommands } from "@/commands/terminal-commands";
import { checkForUpdatesDaily } from "@/features/help/updates";
import { showWhatsNewAfterUpdate } from "@/features/help/whats-new";
import { AppShell } from "@/features/layout/app-shell";
import { installQuickLook } from "@/features/preview/quick-look";
import { applyLanguage } from "@/features/settings/use-preference-effects";
import { t } from "@/i18n";
import { unwrap } from "@/lib/ipc";
import { isMainWindow } from "@/lib/window";
import { loadPreferences, useApp, watchPreferences } from "@/stores/app-store";
import { loadFolderViews } from "@/stores/folder-views";
import { clearRecents, loadRecents } from "@/stores/recents-store";
import { autosaveSession, fromSession, loadSession } from "@/stores/session";
import { useWorkspace } from "@/stores/workspace-store";

registerAppCommands();
registerFileCommands();
registerTabCommands();
registerTerminalCommands();
registerHelpCommands();

let booted: Promise<void> | null = null;
/** Idempotent: StrictMode runs effects twice in dev. */
function bootstrap(): Promise<void> {
  booted ??= loadInitialState();
  return booted;
}

async function loadInitialState(): Promise<void> {
  const [home, launchDir, locations, volumes, fda, prefs, session] = await Promise.all([
    unwrap(commands.homeDir()),
    commands.launchDir(),
    commands.standardLocations(),
    unwrap(commands.listVolumes()).catch(() => []),
    commands.checkFullDiskAccess(),
    loadPreferences(),
    loadSession(),
    loadRecents(),
    loadFolderViews(),
  ]);
  useApp.getState().set({ ...prefs, home, locations, volumes, fullDiskAccess: fda });
  // Before the first render, so the UI doesn't flash in English.
  await applyLanguage(prefs.languagePref ?? "system");
  if (!isMainWindow) {
    // A New Window: one tab on the folder it was opened for.
    const start = (await commands.windowStartPath()) ?? home;
    useWorkspace.setState(fromSession(undefined, start));
    if (prefs.terminalVisible) openTerminal();
    void info(`bootstrap: new window at ${start}`);
    return;
  }
  // Tabs and layout come back as they were; a folder given at launch opens in a new tab.
  useWorkspace.setState(fromSession(prefs.restoreSession === false ? undefined : session, home));
  if (launchDir) openOrActivate(launchDir);
  autosaveSession();
  // Shells don't survive a restart; an open panel comes back with a fresh one.
  if (prefs.terminalVisible) openTerminal();
  await openPendingRequests();
  void showWhatsNewAfterUpdate();
  void checkForUpdatesDaily();
  void info(`bootstrap: home=${home} volumes=${volumes.length} fda=${fda} restored=${session !== undefined}`);
  if (import.meta.env.DEV) {
    selfCheckIcons();
    void import("@/dev/self-test").then((m) => m.runSelfTest());
  }
}

/** Switches to a left-pane tab already showing `path`, or opens one. */
function openOrActivate(path: string): void {
  const ws = useWorkspace.getState();
  const existing = ws.panes.left.tabs.find((t) => t.path === path);
  if (existing) ws.activateTab("left", existing.id);
  else ws.openTab(path, { pane: "left" });
}

/** Requests from the Settings window, which has no access to this window's state. */
function handleSettingsAction(action: string): void {
  if (action === "resetLayout") {
    useWorkspace.setState(fromSession(undefined, useApp.getState().home));
    toast(t("Tabs and layout were reset."));
  } else if (action === "clearRecents") {
    clearRecents();
    toast(t("Recent folders were cleared."));
  }
}

/** Folders handed over by `open -a`, the Dock or a second launch. */
async function openPendingRequests(): Promise<void> {
  const paths = await commands.takeOpenRequests();
  if (paths.length > 0) await openExternalPaths(paths);
}

/** Dev-only: proves the `oxthumb://` scheme + CSP work inside the webview. */
function selfCheckIcons(): void {
  const img = new Image();
  img.onload = () => void info(`oxthumb self-check ok ${img.naturalWidth}x${img.naturalHeight}`);
  img.onerror = () => void logError("oxthumb self-check FAILED");
  img.src = "oxthumb://localhost/ext/64/pdf";
}

export function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    const unlistenMenu = listenToMenu();
    const uninstallKeys = installGlobalKeys();
    const uninstallQuickLook = installQuickLook();
    const unwatchPrefs = watchPreferences();
    const unlistenSettings = listen<{ action: string }>("settings-action", ({ payload }) =>
      handleSettingsAction(payload.action),
    );
    const unlistenOpen = events.openRequested.listen(() => {
      // Requests that arrive before bootstrap finishes are picked up by it.
      if (booted) void booted.then(openPendingRequests);
    });
    bootstrap()
      .catch((err: unknown) => void logError(`bootstrap failed: ${String(err)}`))
      .finally(() => {
        if (disposed) return;
        setReady(true);
        // Epoch ms, so startup can be measured from outside (time from `open` to this line).
        requestAnimationFrame(
          () => void info(`ui ready at ${Date.now()} (${Math.round(performance.now())} ms after page start)`),
        );
      });
    return () => {
      disposed = true;
      uninstallKeys();
      uninstallQuickLook();
      void unwatchPrefs.then((fn) => fn());
      void unlistenSettings.then((fn) => fn());
      void unlistenMenu.then((fn) => fn());
      void unlistenOpen.then((fn) => fn());
    };
  }, []);

  return (
    <>
      {ready && <AppShell />}
      <Toaster position="bottom-right" theme="system" richColors closeButton />
    </>
  );
}
