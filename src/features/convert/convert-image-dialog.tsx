import { useState } from "react";
import { toast } from "sonner";
import { commands, type ImageFormat } from "@/bindings";
import { applyFsChanges, recordUndo } from "@/commands/jobs";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { msg, useT } from "@/i18n";
import { describeError, type FileEntry, toAppError, unwrap } from "@/lib/ipc";
import { basename } from "@/lib/path";
import { selectAll } from "@/lib/selection";
import { useApp } from "@/stores/app-store";
import { useWorkspace } from "@/stores/workspace-store";

const FORMATS: readonly [ImageFormat, string][] = [
  ["jpeg", "JPEG"],
  ["png", "PNG"],
  ["heic", "HEIF"],
  ["tiff", "TIFF"],
];

const SIZES = [
  [null, msg("Actual Size")],
  [3000, msg("Large (3000 px)")],
  [1600, msg("Medium (1600 px)")],
  [640, msg("Small (640 px)")],
] as const;

/** File → Convert Image…: copies of pictures in another format or a smaller size, like Finder's Quick Action. */
export function ConvertImageDialog() {
  const { t } = useT();
  const paths = useApp((s) => s.convertPaths);
  const close = () => useApp.getState().set({ convertPaths: null });
  return (
    <Dialog open={!!paths} onClose={close} label={t("Convert Image")} className="w-[380px]">
      {paths && <Body key={paths.join("\n")} paths={paths} onClose={close} />}
    </Dialog>
  );
}

function Body({ paths, onClose }: { paths: string[]; onClose: () => void }) {
  const { t, tn } = useT();
  const [format, setFormat] = useState<ImageFormat>("jpeg");
  const [size, setSize] = useState<number | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const run = async () => {
    setDone(0);
    const made: FileEntry[] = [];
    const failed: string[] = [];
    for (const path of paths) {
      try {
        made.push(await unwrap(commands.convertImage(path, format, size)));
      } catch (err) {
        failed.push(`${basename(path)}: ${describeError(toAppError(err))}`);
      }
      setDone(made.length + failed.length);
    }
    // Escape may have closed this dialog meanwhile, and another one may be open now.
    const stillOpen = useApp.getState().convertPaths === paths;
    if (made.length > 0) {
      applyFsChanges(made, []);
      recordUndo({ label: msg("Convert Image"), steps: made.map((e) => ({ kind: "trash", path: e.path })) });
      if (stillOpen) useWorkspace.getState().setSelection(selectAll(made.map((e) => e.path)));
    }
    if (failed.length > 0)
      toast.error(
        tn(failed.length, "1 image couldn’t be converted", "{count} images couldn’t be converted"),
        {
          description: failed.slice(0, 3).join("\n"),
        },
      );
    if (stillOpen) onClose();
  };

  const busy = done !== null;
  return (
    <div className="flex flex-col gap-4 p-5 text-[13px]">
      <p className="m-0 font-semibold">
        {paths.length === 1
          ? t("Convert “{name}”", { name: basename(paths[0] ?? "") })
          : tn(paths.length, "Convert 1 image", "Convert {count} images")}
      </p>
      <label className="grid grid-cols-[90px_1fr] items-center gap-2">
        <span className="text-fg-muted">{t("Format")}</span>
        <select
          value={format}
          disabled={busy}
          onChange={(e) => setFormat(e.target.value as ImageFormat)}
          className="h-7 rounded-md border border-border bg-bg px-2"
        >
          {FORMATS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid grid-cols-[90px_1fr] items-center gap-2">
        <span className="text-fg-muted">{t("Image Size")}</span>
        <select
          value={size ?? ""}
          disabled={busy}
          onChange={(e) => setSize(e.target.value === "" ? null : Number(e.target.value))}
          className="h-7 rounded-md border border-border bg-bg px-2"
        >
          {SIZES.map(([value, label]) => (
            <option key={label} value={value ?? ""}>
              {t(label)}
            </option>
          ))}
        </select>
      </label>
      <p className="m-0 text-[12px] text-fg-faint">
        {busy
          ? t("Converting {done} of {total}…", {
              done: done.toLocaleString(),
              total: paths.length.toLocaleString(),
            })
          : t("The originals stay as they are; new files are made next to them.")}
      </p>
      <div className="flex justify-end gap-2">
        <DialogButton onClick={onClose} disabled={busy}>
          {t("Cancel")}
        </DialogButton>
        <DialogButton primary autoFocus disabled={busy} onClick={() => void run()}>
          {t("Convert")}
        </DialogButton>
      </div>
    </div>
  );
}
