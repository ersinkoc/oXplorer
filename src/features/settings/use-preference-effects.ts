import { getCurrentWindow } from "@tauri-apps/api/window";
import { error as logError } from "@tauri-apps/plugin-log";
import { locale } from "@tauri-apps/plugin-os";
import { useEffect } from "react";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { type Language, menuTitles, resolveLanguage, t } from "@/i18n";
import { MENU_LABELS } from "@/i18n/menu-labels";
import { describeError } from "@/lib/ipc";
import { type Preferences, type Theme, useApp } from "@/stores/app-store";

/** System appearance follows the window's NSAppearance, vibrancy included. */
export function applyTheme(theme: Theme): void {
  void getCurrentWindow()
    .setTheme(theme === "system" ? null : theme)
    .catch((err: unknown) => void logError(`setTheme failed: ${String(err)}`));
}

/** Resolves "system" against the macOS language and makes it the UI language. */
export async function applyLanguage(pref: Preferences["languagePref"]): Promise<Language> {
  const system = await locale().catch(() => null);
  const lang = resolveLanguage(pref, system);
  useApp.getState().set({ language: lang });
  return lang;
}

/** Applies preferences that live outside React state: theme, language and menu shortcuts. */
export function usePreferenceEffects(): void {
  const theme = useApp((s) => s.theme);
  const shortcuts = useApp((s) => s.shortcuts);
  const languagePref = useApp((s) => s.languagePref);
  const connections = useApp((s) => s.connections);

  useEffect(() => void commands.remoteSetConnections(connections), [connections]);

  // The native menu bar is labelled by Rust; it gets the translations.
  useEffect(() => {
    let live = true;
    void Promise.all([applyLanguage(languagePref), commands.menuItems()]).then(([lang, items]) => {
      if (!live) return;
      void commands.setMenuTitles(menuTitles(lang, [...MENU_LABELS, ...items.map((i) => i.title)]));
    });
    return () => {
      live = false;
    };
  }, [languagePref]);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    void commands.setShortcuts(shortcuts).then((r) => {
      if (r.status === "error")
        toast.error(t("Custom shortcuts weren’t applied: {reason}", { reason: describeError(r.error) }));
    });
  }, [shortcuts]);
}
