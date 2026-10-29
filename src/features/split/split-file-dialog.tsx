import { useState } from "react";
import { runJob } from "@/commands/jobs";
import { writableFolder } from "@/commands/navigation";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { msg, useT } from "@/i18n";
import { formatSize } from "@/lib/format";
import { basename } from "@/lib/path";
import { isVirtualPath } from "@/lib/search-path";
import { canSplit, partCount } from "@/lib/split-parts";
import { useApp } from "@/stores/app-store";
import { getActiveTab, otherPane, useWorkspace } from "@/stores/workspace-store";

const MB = 1_000_000;
/** Part sizes people need: mail attachments, discs, FAT32's 4 GiB file limit. */
const PRESETS = [
  [25 * MB, msg("25 MB (e-mail)")],
  [100 * MB, msg("100 MB")],
  [700 * MB, msg("700 MB (CD)")],
  [1000 * MB, msg("1 GB")],
  [2 ** 32 - 1, msg("4 GB (FAT32 limit)")],
  [4700 * MB, msg("4.7 GB (DVD)")],
] as const;
const CUSTOM = "custom";

/** File → Split File…: cuts a big file into numbered parts (`.001`, `.002`, …). */
export function SplitFileDialog() {
  const { t } = useT();
  const file = useApp((s) => s.splitFile);
  const close = () => useApp.getState().set({ splitFile: null });
  return (
    <Dialog open={!!file} onClose={close} label={t("Split File")} className="w-[400px]">
      {file && <Body key={file.path} path={file.path} size={file.size} onClose={close} />}
    </Dialog>
  );
}

function Body({ path, size, onClose }: { path: string; size: number; onClose: () => void }) {
  const { t } = useT();
  const here = path.slice(0, path.length - basename(path).length - 1) || "/";
  const { dualPane, activePane } = useWorkspace.getState();
  const there = dualPane ? getActiveTab(otherPane(activePane)).path : null;
  const canUseOther = !!there && there !== here && !isVirtualPath(there);
  const [preset, setPreset] = useState<string>(String(PRESETS[1][0]));
  const [customMb, setCustomMb] = useState("50");
  const [toOther, setToOther] = useState(false);

  const partSize = preset === CUSTOM ? Math.round(Number(customMb) * MB) : Number(preset);
  const valid = Number.isFinite(partSize) && canSplit(size, partSize);

  const run = () => {
    const destDir = toOther && there ? writableFolder(otherPane(activePane)) : here;
    if (!destDir || !valid) return;
    onClose();
    void runJob({ kind: "split", source: path, destDir, partSize });
  };

  return (
    <form
      className="flex flex-col gap-4 p-5 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        run();
      }}
    >
      <p className="m-0 font-semibold">
        {t("Split “{name}” ({size})", { name: basename(path), size: formatSize(size) })}
      </p>
      <label className="grid grid-cols-[90px_1fr] items-center gap-2">
        <span className="text-fg-muted">{t("Part Size")}</span>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
          className="h-7 rounded-md border border-border bg-bg px-2"
        >
          {PRESETS.map(([bytes, label]) => (
            <option key={bytes} value={String(bytes)}>
              {t(label)}
            </option>
          ))}
          <option value={CUSTOM}>{t("Custom…")}</option>
        </select>
      </label>
      {preset === CUSTOM && (
        <label className="grid grid-cols-[90px_1fr] items-center gap-2">
          <span className="text-fg-muted">{t("Megabytes")}</span>
          <input
            type="number"
            min={1}
            step="any"
            value={customMb}
            onChange={(e) => setCustomMb(e.target.value)}
            className="h-7 rounded-md border border-border bg-bg px-2 outline-none focus:ring-2 focus:ring-accent/40"
          />
        </label>
      )}
      {canUseOther && (
        <label className="grid grid-cols-[90px_1fr] items-center gap-2">
          <span className="text-fg-muted">{t("Save To")}</span>
          <select
            value={toOther ? "other" : "here"}
            onChange={(e) => setToOther(e.target.value === "other")}
            className="h-7 rounded-md border border-border bg-bg px-2"
          >
            <option value="here">{t("Same Folder")}</option>
            <option value="other">{t("Other Pane ({name})", { name: basename(there) || "/" })}</option>
          </select>
        </label>
      )}
      <p className="m-0 text-[12px] text-fg-faint">
        {valid
          ? t(
              "Makes {count} parts named “{name}.001”, “.002”, … Select the first part and choose Combine Files to join them.",
              { count: partCount(size, partSize).toLocaleString(), name: basename(path) },
            )
          : partSize >= size
            ? t("The file is smaller than one part.")
            : t("That would make more than 999 parts. Choose a bigger part size.")}
      </p>
      <div className="flex justify-end gap-2">
        <DialogButton onClick={onClose}>{t("Cancel")}</DialogButton>
        <DialogButton primary disabled={!valid} onClick={run}>
          {t("Split")}
        </DialogButton>
      </div>
    </form>
  );
}
