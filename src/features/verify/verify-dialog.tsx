import { Channel } from "@tauri-apps/api/core";
import { CircleAlert, CircleCheck, CircleHelp, CircleX } from "lucide-react";
import { useEffect, useState } from "react";
import { commands, type HashKind, type VerifyEvent, type VerifyStatus } from "@/bindings";
import { navigateTo } from "@/commands/navigation";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { msg, useT } from "@/i18n";
import { describeError } from "@/lib/ipc";
import { basename, parent } from "@/lib/path";
import { useApp } from "@/stores/app-store";

/** File → Verify Checksums…: checks the files a checksum list names. */
export function VerifyDialog() {
  const { t } = useT();
  const path = useApp((s) => s.verifyPath);
  const close = () => useApp.getState().set({ verifyPath: null });
  return (
    <Dialog
      open={!!path}
      onClose={close}
      label={t("Verify Checksums")}
      className="flex max-h-[78vh] w-[600px] max-w-[92vw] flex-col"
    >
      {path && <Body key={path} path={path} onClose={close} />}
    </Dialog>
  );
}

interface Item {
  name: string;
  path: string;
  kind: HashKind;
  status: VerifyStatus;
}

interface Run {
  total: number;
  items: Item[];
  done: boolean;
  error: string | null;
}

const KIND_LABELS: Record<HashKind, string> = {
  md5: "MD5",
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha512: "SHA-512",
};

const STATUS = {
  ok: { label: msg("OK"), icon: CircleCheck, className: "text-green-600" },
  mismatch: { label: msg("Doesn’t match"), icon: CircleX, className: "text-red-500" },
  missing: { label: msg("Missing"), icon: CircleHelp, className: "text-fg-muted" },
  unreadable: { label: msg("Couldn’t be read"), icon: CircleAlert, className: "text-amber-500" },
} as const;

/** Checks `path`; cancelled when the window closes. */
function useVerify(path: string): Run {
  const [run, setRun] = useState<Run>({ total: 0, items: [], done: false, error: null });
  useEffect(() => {
    const id = crypto.randomUUID();
    const channel = new Channel<VerifyEvent>();
    channel.onmessage = (ev: VerifyEvent) =>
      setRun((r) =>
        ev.type === "started"
          ? { ...r, total: ev.total }
          : ev.type === "item"
            ? { ...r, items: [...r.items, ev] }
            : { ...r, done: true },
      );
    void commands.verifyChecksums(id, path, channel).then((r) => {
      if (r.status === "error") setRun((s) => ({ ...s, done: true, error: describeError(r.error) }));
    });
    return () => void commands.cancelJob(id);
  }, [path]);
  return run;
}

function Body({ path, onClose }: { path: string; onClose: () => void }) {
  const { t } = useT();
  const run = useVerify(path);
  const bad = run.items.filter((i) => i.status !== "ok").length;
  const reveal = (p: string) => {
    navigateTo(parent(p) ?? "/", { select: p });
    onClose();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[13px]">
      <header className="border-b border-border px-4 py-3">
        <p className="m-0 font-semibold">{t("Checksums in “{name}”", { name: basename(path) })}</p>
        <p className="m-0 text-[12px] text-fg-muted" aria-live="polite">
          {run.error
            ? run.error
            : !run.done
              ? t("Checking {done} of {total}…", {
                  done: run.items.length.toLocaleString(),
                  total: run.total.toLocaleString(),
                })
              : bad === 0
                ? t("All {count} files are intact.", { count: run.items.length.toLocaleString() })
                : t("{bad} of {count} files failed the check.", {
                    bad: bad.toLocaleString(),
                    count: run.items.length.toLocaleString(),
                  })}
        </p>
      </header>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
        {run.items.map((item, i) => {
          const s = STATUS[item.status];
          const Icon = s.icon;
          return (
            <li
              // A list may name the same file twice (one line per algorithm).
              // biome-ignore lint/suspicious/noArrayIndexKey: items only ever append
              key={i}
              className="grid grid-cols-[18px_1fr_auto_auto] items-center gap-2 border-b border-border/60 px-4 py-1.5"
            >
              <Icon className={`size-4 ${s.className}`} aria-hidden />
              {item.status === "missing" || !item.path ? (
                <span className="truncate">{item.name}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => reveal(item.path)}
                  className="truncate text-left hover:underline"
                  title={t("Show in Folder")}
                >
                  {item.name}
                </button>
              )}
              <span className="text-[11px] text-fg-faint">{KIND_LABELS[item.kind]}</span>
              <span className={`text-[12px] ${s.className}`}>{t(s.label)}</span>
            </li>
          );
        })}
      </ul>
      <footer className="flex justify-end border-t border-border px-4 py-3">
        <DialogButton primary autoFocus onClick={onClose}>
          {run.done ? t("Done") : t("Stop")}
        </DialogButton>
      </footer>
    </div>
  );
}
