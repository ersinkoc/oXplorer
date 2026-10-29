import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { LazyStore } from "@tauri-apps/plugin-store";
import { check } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { t } from "@/i18n";
import { describeError } from "@/lib/ipc";

const DAY_MS = 86_400_000;
const store = new LazyStore("settings.json");

/**
 * Looks for a signed update on GitHub Releases. `interactive` (the menu item)
 * reports every outcome; the automatic daily check only speaks up when an
 * update exists.
 */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!(await commands.updatesEnabled())) return announceNewerRelease(interactive);
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

/**
 * Builds without the updater (unsigned betas): a newer release on GitHub is
 * announced with a link to its download page.
 */
async function announceNewerRelease(interactive: boolean): Promise<void> {
  const r = await commands.newerRelease();
  if (r.status === "error") {
    if (interactive)
      toast.error(t("Couldn’t check for updates: {reason}", { reason: describeError(r.error) }));
    return;
  }
  if (!r.data) {
    if (interactive) toast.success(t("OXplorer is up to date."));
    return;
  }
  const { version, url } = r.data;
  toast(t("OXplorer {version} is available", { version }), {
    description: t("This build doesn’t update itself; download the new version from GitHub."),
    duration: Number.POSITIVE_INFINITY,
    action: { label: t("Download…"), onClick: () => void openUrl(url) },
  });
}

/** At most once a day, a quiet check at launch. */
export async function checkForUpdatesDaily(): Promise<void> {
  try {
    const last = (await store.get<number>("lastUpdateCheck")) ?? 0;
    // Dev runs (and self-tests) don't ask GitHub.
    if (import.meta.env.DEV || Date.now() - last < DAY_MS) return;
    await store.set("lastUpdateCheck", Date.now());
    await checkForUpdates(false);
  } catch (err) {
    console.warn("daily update check skipped", err);
  }
}
