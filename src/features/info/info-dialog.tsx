import { Channel } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { commands, type MeasureEvent, type SizeInfo } from "@/bindings";
import { FileIcon } from "@/features/file-view/file-icon";
import { TagDots } from "@/features/file-view/tag-dots";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";
import { formatDate, formatSize, isFolderLike, kindLabel } from "@/lib/format";
import type { FileEntry } from "@/lib/ipc";
import { parent, tildify } from "@/lib/path";
import { useApp } from "@/stores/app-store";

/** "Get Info" for the selection (⌘I). Folder sizes are computed live and cancelled on close. */
export function InfoDialog() {
  const { t } = useT();
  const paths = useApp((s) => s.infoPaths);
  const close = () => useApp.getState().set({ infoPaths: null });
  return (
    <Dialog open={!!paths} onClose={close} label={t("Info")} className="w-[380px]">
      {paths && <InfoBody key={paths.join("\n")} paths={paths} onClose={close} />}
    </Dialog>
  );
}

function useEntries(paths: readonly string[]): FileEntry[] {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  useEffect(() => {
    let stale = false;
    void Promise.all(paths.map((p) => commands.statPath(p))).then((results) => {
      if (stale) return;
      setEntries(results.flatMap((r) => (r.status === "ok" ? [r.data] : [])));
    });
    return () => {
      stale = true;
    };
  }, [paths]);
  return entries;
}

function useMeasure(paths: readonly string[], needed: boolean): { size: SizeInfo | null; done: boolean } {
  const [state, setState] = useState<{ size: SizeInfo | null; done: boolean }>({ size: null, done: false });
  useEffect(() => {
    if (!needed) return;
    const id = crypto.randomUUID();
    const channel = new Channel<MeasureEvent>();
    channel.onmessage = (ev) => setState({ size: ev.size, done: ev.type === "done" });
    void commands.measure(id, [...paths], channel);
    return () => void commands.cancelJob(id);
  }, [paths, needed]);
  return state;
}

/** SHA-256 on request (big files take a while); cancelled when the panel closes. */
function Checksum({ path }: { path: string }) {
  const { t } = useT();
  const [state, setState] = useState<"idle" | "running" | "failed" | { hash: string }>("idle");
  useEffect(() => {
    if (state !== "running") return;
    const id = crypto.randomUUID();
    let live = true;
    void commands.checksum(id, path).then((r) => {
      if (live) setState(r.status === "ok" ? { hash: r.data } : "failed");
    });
    return () => {
      live = false;
      void commands.cancelJob(id);
    };
  }, [state, path]);

  if (state === "idle")
    return (
      <button type="button" onClick={() => setState("running")} className="text-accent hover:underline">
        {t("Calculate")}
      </button>
    );
  if (state === "failed") return <span className="text-fg-muted">{t("Couldn’t read the file.")}</span>;
  if (state === "running") return <span className="text-fg-muted">{t("Calculating…")}</span>;
  return <span className="font-mono text-[11px] break-all">{state.hash}</span>;
}

function permissions(mode: number): string {
  const bits = "rwxrwxrwx";
  let out = "";
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : "-";
  return `${out}  (${(mode & 0o777).toString(8).padStart(3, "0")})`;
}

function InfoBody({ paths, onClose }: { paths: string[]; onClose: () => void }) {
  const { t, tn } = useT();
  const entries = useEntries(paths);
  const home = useApp((s) => s.home);
  const [single] = entries;
  const needsMeasure =
    entries.length > 1 || (!!single && (isFolderLike(single) || single.kind === "package"));
  const { size, done } = useMeasure(paths, needsMeasure);

  if (!single) return <div className="p-5 text-fg-muted">{t("Loading…")}</div>;

  const sizeLabel = needsMeasure
    ? size
      ? `${tn(size.files, "{size} on disk {allocated} for {count} item", "{size} on disk {allocated} for {count} items", { size: formatSize(size.bytes), allocated: formatSize(size.allocated) })}${done ? "" : "…"}`
      : t("Calculating…")
    : t("{size} ({bytes} bytes)", { size: formatSize(single.size), bytes: single.size.toLocaleString() });

  const rows: [string, React.ReactNode][] =
    entries.length > 1
      ? [
          [t("Items"), entries.length.toLocaleString()],
          [t("Size"), sizeLabel],
          [t("Where"), tildify(parent(single.path) ?? "/", home)],
        ]
      : [
          [t("Kind"), kindLabel(single)],
          [t("Size"), sizeLabel],
          [t("Where"), tildify(parent(single.path) ?? "/", home)],
          [t("Created"), single.createdMs ? formatDate(single.createdMs) : "--"],
          [t("Modified"), formatDate(single.modifiedMs)],
          [
            t("Permissions"),
            <span key="perm" className="font-mono text-[11px]">
              {permissions(single.mode)}
            </span>,
          ],
          ...(single.symlink
            ? ([[t("Original"), single.symlink.target]] as [string, React.ReactNode][])
            : []),
          ...(single.kind === "file"
            ? ([["SHA-256", <Checksum key="sha" path={single.path} />]] as [string, React.ReactNode][])
            : []),
          ...(single.tags.length > 0
            ? ([
                [
                  t("Tags"),
                  <span key="tags" className="flex items-center gap-1">
                    <TagDots tags={single.tags} />
                    {single.tags.map((tag) => tag.name).join(", ")}
                  </span>,
                ],
              ] as [string, React.ReactNode][])
            : []),
        ];

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center gap-3">
        <FileIcon entry={single} size={64} thumbnail />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold" title={single.name}>
            {entries.length > 1 ? tn(entries.length, "{count} item", "{count} items") : single.name}
          </div>
          <div className="text-[12px] text-fg-muted">
            {entries.length > 1 ? "" : formatDate(single.modifiedMs)}
          </div>
        </div>
      </div>
      <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-right text-fg-muted">{k}:</dt>
            <dd className="min-w-0 break-words select-text">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex justify-end">
        <DialogButton primary autoFocus onClick={onClose}>
          {t("Done")}
        </DialogButton>
      </div>
    </div>
  );
}
