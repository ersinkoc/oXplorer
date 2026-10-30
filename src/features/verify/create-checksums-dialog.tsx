import { useState } from "react";
import type { HashKind } from "@/bindings";
import { runJob } from "@/commands/jobs";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { msg, useT } from "@/i18n";
import { checksumListName } from "@/lib/checksum-list";
import { basename } from "@/lib/path";
import { useApp } from "@/stores/app-store";

const ALGORITHMS: readonly (readonly [HashKind, string])[] = [
  ["sha256", msg("SHA-256 (recommended)")],
  ["sha512", "SHA-512"],
  ["sha1", "SHA-1"],
  ["md5", "MD5"],
];

/** File → Create Checksum File…: hashes the selected files into a list beside them. */
export function CreateChecksumsDialog() {
  const { t } = useT();
  const sources = useApp((s) => s.checksumPaths);
  const close = () => useApp.getState().set({ checksumPaths: null });
  return (
    <Dialog open={!!sources} onClose={close} label={t("Create Checksum File")} className="w-[400px]">
      {sources && <Body key={sources.join("\n")} sources={sources} onClose={close} />}
    </Dialog>
  );
}

function Body({ sources, onClose }: { sources: string[]; onClose: () => void }) {
  const { t, tn } = useT();
  const [algorithm, setAlgorithm] = useState<HashKind>("sha256");
  const names = sources.map(basename);

  const run = () => {
    onClose();
    void runJob({ kind: "checksums", sources, algorithm });
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
        {names.length === 1
          ? t("Checksum of “{name}”", { name: names[0] ?? "" })
          : tn(names.length, "Checksum of {count} file", "Checksums of {count} files")}
      </p>
      <label className="grid grid-cols-[90px_1fr] items-center gap-2">
        <span className="text-fg-muted">{t("Algorithm")}</span>
        <select
          value={algorithm}
          onChange={(e) => setAlgorithm(e.target.value as HashKind)}
          className="h-7 rounded-md border border-border bg-bg px-2"
        >
          {ALGORITHMS.map(([kind, label]) => (
            <option key={kind} value={kind}>
              {t(label)}
            </option>
          ))}
        </select>
      </label>
      <p className="m-0 text-[12px] text-fg-faint">
        {t("Saves “{name}” in the same folder. Choose Verify Checksums… on it later to check the files.", {
          name: checksumListName(algorithm, names),
        })}
      </p>
      <div className="flex justify-end gap-2">
        <DialogButton onClick={onClose}>{t("Cancel")}</DialogButton>
        <DialogButton primary onClick={run}>
          {t("Create")}
        </DialogButton>
      </div>
    </form>
  );
}
