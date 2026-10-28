import { getVersion } from "@tauri-apps/api/app";
import { LazyStore } from "@tauri-apps/plugin-store";
import { lazy, Suspense } from "react";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";
import { useApp } from "@/stores/app-store";
import changelog from "../../../CHANGELOG.md?raw";

const MarkdownView = lazy(() => import("@/features/preview/markdown-view"));
const store = new LazyStore("settings.json");

/** Help → What's New, and once automatically after an update. */
export function WhatsNewDialog() {
  const { t } = useT();
  const open = useApp((s) => s.whatsNewOpen);
  const close = () => useApp.getState().set({ whatsNewOpen: false });
  return (
    <Dialog open={open} onClose={close} label={t("What’s New")} className="w-[560px]">
      <div className="flex max-h-[70vh] flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto select-text">
          <Suspense fallback={null}>
            {/* The changelog's own "# Changelog" heading is dropped. */}
            <MarkdownView text={changelog.replace(/^# .*\n/, "")} />
          </Suspense>
        </div>
        <div className="flex justify-end border-t border-border p-3">
          <DialogButton primary autoFocus onClick={close}>
            {t("Continue")}
          </DialogButton>
        </div>
      </div>
    </Dialog>
  );
}

/** Opens What's New when the version changed since the last launch (not on a first install). */
export async function showWhatsNewAfterUpdate(): Promise<void> {
  try {
    const [version, seen] = await Promise.all([getVersion(), store.get<string>("lastSeenVersion")]);
    if (seen && seen !== version) useApp.getState().set({ whatsNewOpen: true });
    if (seen !== version) await store.set("lastSeenVersion", version);
  } catch (err) {
    console.warn("what's new check failed", err);
  }
}
