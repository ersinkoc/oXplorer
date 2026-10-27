import { useState } from "react";
import type { ConflictChoice } from "@/bindings";
import { resolveConflict } from "@/commands/jobs";
import { FileIcon } from "@/features/file-view/file-icon";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { entrySizeLabel, formatDate } from "@/lib/format";
import type { FileEntry } from "@/lib/ipc";
import { useJobs } from "@/stores/jobs-store";

/** Shown while any job is paused on a name clash. */
export function ConflictDialog() {
  const job = useJobs((s) => Object.values(s.jobs).find((j) => j.conflict));
  const [applyToAll, setApplyToAll] = useState(false);
  const conflict = job?.conflict;

  const answer = (choice: ConflictChoice) => {
    if (!job) return;
    resolveConflict(job.id, { choice, applyToAll });
    setApplyToAll(false);
  };

  return (
    <Dialog
      open={!!conflict}
      onClose={() => answer("stop")}
      label="Item already exists"
      className="w-[460px]"
    >
      {conflict && (
        <div className="flex flex-col gap-4 p-5">
          <p className="text-[13px] leading-5">
            An item named <strong>“{conflict.existing.name}”</strong> already exists in this location. Do you
            want to replace it with the one you’re{" "}
            {job?.label.toLowerCase().startsWith("mov") ? "moving" : "copying"}?
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Side title="Existing" entry={conflict.existing} />
            <Side title="Incoming" entry={conflict.source} />
          </div>
          <label className="flex items-center gap-2 text-[12px] text-fg-muted">
            <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
            Apply to all
          </label>
          <div className="flex justify-between">
            <DialogButton onClick={() => answer("stop")}>Stop</DialogButton>
            <div className="flex gap-2">
              <DialogButton onClick={() => answer("skip")}>Skip</DialogButton>
              <DialogButton onClick={() => answer("keepBoth")}>Keep Both</DialogButton>
              <DialogButton primary autoFocus onClick={() => answer("replace")}>
                Replace
              </DialogButton>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Side({ title, entry }: { title: string; entry: FileEntry }) {
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
