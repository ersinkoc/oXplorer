import { info, error as logError } from "@tauri-apps/plugin-log";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { commands, events } from "@/bindings";
import { registerAppCommands } from "@/commands/app-commands";
import { registerFileCommands } from "@/commands/file-commands";
import { installGlobalKeys } from "@/commands/keymap";
import { openExternalPaths } from "@/commands/navigation";
import { listenToMenu } from "@/commands/registry";
import { registerTabCommands } from "@/commands/tab-commands";
import { AppShell } from "@/features/layout/app-shell";
import { installQuickLook } from "@/features/preview/quick-look";
import { unwrap } from "@/lib/ipc";
import { loadPreferences, useApp } from "@/stores/app-store";
import { autosaveSession, fromSession, loadSession } from "@/stores/session";
import { useWorkspace } from "@/stores/workspace-store";

registerAppCommands();
registerFileCommands();
registerTabCommands();

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
  ]);
  useApp.getState().set({ ...prefs, home, locations, volumes, fullDiskAccess: fda });
  // Tabs and layout come back as they were; a folder given at launch opens in a new tab.
  useWorkspace.setState(fromSession(session, home));
  if (launchDir) openOrActivate(launchDir);
  autosaveSession();
  await openPendingRequests();
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
    const unlistenOpen = events.openRequested.listen(() => {
      // Requests that arrive before bootstrap finishes are picked up by it.
      if (booted) void booted.then(openPendingRequests);
    });
    bootstrap()
      .catch((err: unknown) => void logError(`bootstrap failed: ${String(err)}`))
      .finally(() => {
        if (!disposed) setReady(true);
      });
    return () => {
      disposed = true;
      uninstallKeys();
      uninstallQuickLook();
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
