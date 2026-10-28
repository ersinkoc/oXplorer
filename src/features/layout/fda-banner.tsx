import { ShieldAlert, X } from "lucide-react";
import { commands } from "@/bindings";
import { useT } from "@/i18n";
import { useApp } from "@/stores/app-store";

export function FdaBanner() {
  const { t } = useT();
  const denied = useApp((s) => s.fullDiskAccess === "denied");
  const dismissed = useApp((s) => s.fdaBannerDismissed);
  if (!denied || dismissed) return null;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[12px]">
      <ShieldAlert className="size-4 shrink-0 text-amber-600" />
      <span className="flex-1 text-fg">
        {t("Some folders (Mail, Safari, other apps’ data) stay hidden until OXplorer has Full Disk Access.")}
      </span>
      <button
        type="button"
        className="rounded px-2 py-0.5 font-medium text-accent hover:bg-hover"
        onClick={() => void commands.openFullDiskAccessSettings()}
      >
        {t("Open Settings")}
      </button>
      <button
        type="button"
        aria-label={t("Dismiss")}
        className="rounded p-0.5 text-fg-muted hover:bg-hover"
        onClick={() => useApp.getState().set({ fdaBannerDismissed: true })}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
