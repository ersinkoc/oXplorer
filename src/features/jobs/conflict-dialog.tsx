import { useState } from "react";
import type { ConflictChoice } from "@/bindings";
import { resolveConflict } from "@/commands/jobs";
import { FileIcon } from "@/features/file-view/file-icon";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";
import { entrySizeLabel, formatDate } from "@/lib/format";
import type { FileEntry } from "@/lib/ipc";
import { useJobs } from "@/stores/jobs-store";

/** Shown while any job is paused on a name clash. */
export function ConflictDialog() {
  const { t } = useT();
  const job = useJobs((s) => Object.values(s.jobs).find((j) => j.conflict));
  const [applyToAll, setApplyToAll] = useState(false);
  const conflict = job?.conflict;
  // Folder onto folder can also merge (Finder offers it with ⌥ held; here it's always shown).
  const folders = conflict?.source.kind === "dir" && conflict.existing.kind === "dir";
  // The name is set in bold, so the sentence is split around its placeholder.
  const [before = "", after = ""] = (
    job?.label.toLowerCase().startsWith("mov")
      ? t(
          "An item named {name} already exists in this location. Do you want to replace it with the one you’re moving?",
        )
      : t(
          "An item named {name} already exists in this location. Do you want to replace it with the one you’re copying?",
        )
  ).split("{name}");

  const answer = (choice: ConflictChoice) => {
    if (!job) return;
    resolveConflict(job.id, { choice, applyToAll });
    setApplyToAll(false);
  };

  return (
    <Dialog
      open={!!conflict}
      onClose={() => answer("stop")}
      label={t("Item already exists")}
      className="w-[460px]"
    >
      {conflict && (
        <div className="flex flex-col gap-4 p-5">
          <p className="text-[13px] leading-5">
            {before}
            <strong>“{conflict.existing.name}”</strong>
            {after}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Side title={t("Existing")} entry={conflict.existing} />
            <Side title={t("Incoming")} entry={conflict.source} />
          </div>
          <label className="flex items-center gap-2 text-[12px] text-fg-muted">
            <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
            {t("Apply to all")}
          </label>
          <div className="flex justify-between">
            <DialogButton onClick={() => answer("stop")}>{t("Stop")}</DialogButton>
            <div className="flex gap-2">
              <DialogButton onClick={() => answer("skip")}>{t("Skip")}</DialogButton>
              <DialogButton onClick={() => answer("keepBoth")}>{t("Keep Both")}</DialogButton>
              {folders && <DialogButton onClick={() => answer("merge")}>{t("Merge")}</DialogButton>}
              <DialogButton primary autoFocus onClick={() => answer("replace")}>
                {t("Replace")}
              </DialogButton>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Side({ title, entry }: { title: string; entry: FileEntry }) {
  useT();
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border p-2">
      <FileIcon entry={entry} size={32} thumbnail />
      <div className="min-w-0 text-[11px] leading-4">
        <div className="font-semibold text-fg">{title}</div>
        <div className="text-fg-muted">{entrySizeLabel(entry)}</div>
        <div className="truncate text-fg-muted">{formatDate(entry.modifiedMs)}</div>
      </div>
    </div>
  );
}
