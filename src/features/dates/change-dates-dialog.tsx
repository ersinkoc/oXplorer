import { useState } from "react";
import { commands } from "@/bindings";
import { applyFsChanges, recordUndo } from "@/commands/jobs";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";
import { fromDateInput, toDateInput } from "@/lib/date-input";
import { describeError, type FileEntry } from "@/lib/ipc";
import { useApp } from "@/stores/app-store";

/** File → Change Dates…: sets the modified and/or created date of the selected items. */
export function ChangeDatesDialog() {
  const { t } = useT();
  const entries = useApp((s) => s.datesEntries);
  const close = () => useApp.getState().set({ datesEntries: null });
  return (
    <Dialog open={!!entries} onClose={close} label={t("Change Dates")} className="w-[420px]">
      {entries && <Body key={entries.map((e) => e.path).join("\n")} entries={entries} onClose={close} />}
    </Dialog>
  );
}

function Body({ entries, onClose }: { entries: FileEntry[]; onClose: () => void }) {
  const { t, tn } = useT();
  const first = entries[0];
  const [modifiedOn, setModifiedOn] = useState(true);
  const [createdOn, setCreatedOn] = useState(false);
  const [modified, setModified] = useState(toDateInput(first?.modifiedMs ?? Date.now()));
  const [created, setCreated] = useState(toDateInput(first?.createdMs ?? first?.modifiedMs ?? Date.now()));
  const [error, setError] = useState<string | null>(null);

  const modifiedMs = modifiedOn ? fromDateInput(modified) : null;
  const createdMs = createdOn ? fromDateInput(created) : null;
  const invalid = (modifiedOn && modifiedMs === null) || (createdOn && createdMs === null);
  // macOS moves a created date back to the modified date when it would come later.
  const backwards = modifiedMs !== null && createdMs !== null && createdMs > modifiedMs;
  const valid = (modifiedOn || createdOn) && !invalid && !backwards;

  const run = async () => {
    if (!valid) return;
    const out = await commands.setDates(
      entries.map((e) => e.path),
      modifiedMs,
      createdMs,
    );
    if (out.status === "error") {
      setError(describeError(out.error));
      return;
    }
    applyFsChanges(out.data.entries, []);
    recordUndo(out.data.undo);
    onClose();
  };

  const row = (
    label: string,
    on: boolean,
    setOn: (v: boolean) => void,
    value: string,
    setValue: (v: string) => void,
  ) => (
    <div className="grid grid-cols-[110px_1fr_auto] items-center gap-2">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>{label}</span>
      </label>
      <input
        type="datetime-local"
        step={1}
        disabled={!on}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 rounded-md border border-border bg-bg px-2 outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-50"
      />
      <DialogButton disabled={!on} onClick={() => setValue(toDateInput(Date.now()))}>
        {t("Now")}
      </DialogButton>
    </div>
  );

  return (
    <form
      className="flex flex-col gap-4 p-5 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <p className="m-0 font-semibold">
        {entries.length === 1
          ? t("Dates of “{name}”", { name: first?.name ?? "" })
          : tn(entries.length, "Dates of {count} item", "Dates of {count} items")}
      </p>
      {row(t("Modified"), modifiedOn, setModifiedOn, modified, setModified)}
      {row(t("Created"), createdOn, setCreatedOn, created, setCreated)}
      {(backwards || error) && (
        <p className="m-0 text-[12px] text-red-500">
          {error ?? t("The created date can’t be later than the modified date.")}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <DialogButton onClick={onClose}>{t("Cancel")}</DialogButton>
        <DialogButton primary disabled={!valid} onClick={() => void run()}>
          {t("Change")}
        </DialogButton>
      </div>
    </form>
  );
}
