import { Channel } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { commands, type DupEvent } from "@/bindings";
import { runJob } from "@/commands/jobs";
import { navigateTo } from "@/commands/navigation";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";
import { formatSize } from "@/lib/format";
import { basename, parent, tildify } from "@/lib/path";
import { useApp } from "@/stores/app-store";

/** View → Find Duplicates…: files with the same contents under a folder. */
export function DuplicatesDialog() {
  const { t } = useT();
  const path = useApp((s) => s.duplicatesPath);
  const close = () => useApp.getState().set({ duplicatesPath: null });
  return (
    <Dialog
      open={!!path}
      onClose={close}
      label={t("Find Duplicates")}
      className="flex h-[78vh] w-[760px] max-w-[92vw] flex-col"
    >
      {path && <Body key={path} path={path} onClose={close} />}
    </Dialog>
  );
}

interface Group {
  size: number;
  paths: string[];
}

interface Scan {
  groups: Group[];
  scanned: number;
  hashed: number;
  done: boolean;
}

/** Runs the search for `path`; it's cancelled when the window closes. */
function useDuplicates(path: string): [Scan, (update: (groups: Group[]) => Group[]) => void] {
  const [scan, setScan] = useState<Scan>({ groups: [], scanned: 0, hashed: 0, done: false });
  useEffect(() => {
    const id = crypto.randomUUID();
    const channel = new Channel<DupEvent>();
    channel.onmessage = (ev) =>
      setScan((s) =>
        ev.type === "group"
          ? { ...s, groups: [...s.groups, { size: ev.size, paths: ev.paths }] }
          : ev.type === "progress"
            ? { ...s, scanned: ev.scanned, hashed: ev.hashed }
            : { ...s, done: true },
      );
    void commands.findDuplicates(id, path, channel).then((r) => {
      if (r.status === "error") setScan((s) => ({ ...s, done: true }));
    });
    return () => void commands.cancelJob(id);
  }, [path]);
  const update = (fn: (groups: Group[]) => Group[]) => setScan((s) => ({ ...s, groups: fn(s.groups) }));
  return [scan, update];
}

function Body({ path, onClose }: { path: string; onClose: () => void }) {
  const { t, tn } = useT();
  const home = useApp((s) => s.home);
  const [scan, updateGroups] = useDuplicates(path);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { groups } = scan;
  const wasted = groups.reduce((sum, g) => sum + g.size * (g.paths.length - 1), 0);
  const checkedBytes = groups.reduce(
    (sum, g) => sum + g.size * g.paths.filter((p) => checked.has(p)).length,
    0,
  );

  const toggle = (p: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  // Keeps the first copy of each group (by path) and selects the rest.
  const selectExtras = () => setChecked(new Set(groups.flatMap((g) => g.paths.slice(1))));

  const trash = async () => {
    const sources = [...checked];
    setBusy(true);
    const out = await runJob({ kind: "trash", paths: sources });
    setBusy(false);
    const failed = new Set((out?.failures ?? []).map((f) => f.path));
    const gone = new Set(sources.filter((p) => !failed.has(p)));
    updateGroups((gs) =>
      gs.map((g) => ({ ...g, paths: g.paths.filter((p) => !gone.has(p)) })).filter((g) => g.paths.length > 1),
    );
    setChecked(new Set());
  };

  const reveal = (p: string) => {
    navigateTo(parent(p) ?? "/", { select: p });
    onClose();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[13px]">
      <header className="border-b border-border px-4 py-3">
        <p className="m-0 font-semibold">{t("Duplicates in “{name}”", { name: basename(path) || path })}</p>
        <p className="m-0 text-[12px] text-fg-muted">
          {scan.done
            ? groups.length === 0
              ? t("No duplicates found.")
              : t("{groups}, {size} could be freed", {
                  groups: tn(groups.length, "1 set of identical files", "{count} sets of identical files"),
                  size: formatSize(wasted),
                })
            : t("Looking… {scanned} files, {hashed} compared", {
                scanned: scan.scanned.toLocaleString(),
                hashed: scan.hashed.toLocaleString(),
              })}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {groups.map((g) => (
          <section key={g.paths[0]} className="mb-2 rounded-lg border border-border">
            <h3 className="m-0 border-b border-border bg-bg-alt px-3 py-1 text-[11px] font-medium text-fg-muted">
              {tn(g.paths.length, "1 copy", "{count} copies")} · {formatSize(g.size)}
            </h3>
            <ul className="m-0 list-none p-0">
              {g.paths.map((p) => (
                <li key={p} className="flex items-center gap-2 px-3 py-0.5">
                  <input
                    type="checkbox"
                    aria-label={t("Select {name}", { name: basename(p) })}
                    checked={checked.has(p)}
                    onChange={() => toggle(p)}
                  />
                  <button
                    type="button"
                    title={t("Show in folder")}
                    onClick={() => reveal(p)}
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                  >
                    {tildify(p, home)}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
        <DialogButton onClick={selectExtras} disabled={groups.length === 0}>
          {t("Select All but One")}
        </DialogButton>
        <span className="flex-1 text-[12px] text-fg-muted">
          {checked.size > 0 &&
            tn(checked.size, "1 file selected ({size})", "{count} files selected ({size})", {
              size: formatSize(checkedBytes),
            })}
        </span>
        <DialogButton onClick={onClose}>{t("Done")}</DialogButton>
        <DialogButton primary disabled={checked.size === 0 || busy} onClick={() => void trash()}>
          {t("Move to Trash")}
        </DialogButton>
      </footer>
    </div>
  );
}
