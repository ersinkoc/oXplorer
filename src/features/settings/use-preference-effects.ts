import { getCurrentWindow } from "@tauri-apps/api/window";
import { error as logError } from "@tauri-apps/plugin-log";
import { useEffect } from "react";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { describeError } from "@/lib/ipc";
import { type Theme, useApp } from "@/stores/app-store";

/** System appearance follows the window's NSAppearance, vibrancy included. */
export function applyTheme(theme: Theme): void {
  void getCurrentWindow()
    .setTheme(theme === "system" ? null : theme)
    .catch((err: unknown) => void logError(`setTheme failed: ${String(err)}`));
}

/** Applies preferences that live outside React state: theme and menu shortcuts. */
export function usePreferenceEffects(): void {
  const theme = useApp((s) => s.theme);
  const shortcuts = useApp((s) => s.shortcuts);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    void commands.setShortcuts(shortcuts).then((r) => {
      if (r.status === "error") toast.error(`Custom shortcuts weren’t applied: ${describeError(r.error)}`);
    });
  }, [shortcuts]);
}
