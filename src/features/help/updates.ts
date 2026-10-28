import { relaunch } from "@tauri-apps/plugin-process";
import { LazyStore } from "@tauri-apps/plugin-store";
import { check } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { t } from "@/i18n";

const DAY_MS = 86_400_000;
const store = new LazyStore("settings.json");

/**
 * Looks for a signed update on GitHub Releases. `interactive` (the menu item)
 * reports every outcome; the automatic daily check only speaks up when an
 * update exists.
 */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!(await commands.updatesEnabled())) {
    if (interactive) toast(t("This build doesn’t update itself. Download new versions from GitHub."));
    return;
  }
  try {
    const update = await check();
    if (!update) {
      if (interactive) toast.success(t("OXplorer is up to date."));
      return;
    }
    toast(t("OXplorer {version} is available", { version: update.version }), {
      description: update.body?.split("\n").find((l) => l.trim()) ?? undefined,
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: t("Install and Relaunch"),
        onClick: () => {
          const progress = toast.loading(t("Downloading update…"));
          void update
            .downloadAndInstall()
            .then(() => relaunch())
            .catch((err: unknown) => {
              toast.dismiss(progress);
              toast.error(t("The update couldn’t be installed: {reason}", { reason: String(err) }));
            });
        },
      },
    });
  } catch (err) {
    if (interactive) toast.error(t("Couldn’t check for updates: {reason}", { reason: String(err) }));
    else console.warn("update check failed", err);
  }
}

/** At most once a day, a quiet check at launch. */
export async function checkForUpdatesDaily(): Promise<void> {
  try {
    const last = (await store.get<number>("lastUpdateCheck")) ?? 0;
    if (Date.now() - last < DAY_MS) return;
    await store.set("lastUpdateCheck", Date.now());
    await checkForUpdates(false);
  } catch (err) {
    console.warn("daily update check skipped", err);
  }
}
