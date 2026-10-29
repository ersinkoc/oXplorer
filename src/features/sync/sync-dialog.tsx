import { Channel } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowRight, Equal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { commands, type SyncEvent, type SyncSide, type SyncStatus } from "@/bindings";
import { runJob } from "@/commands/jobs";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { msg, useT } from "@/i18n";
import { formatDate, formatSize } from "@/lib/format";
import { basename } from "@/lib/path";
import { useApp } from "@/stores/app-store";

/** Pane → Synchronize Folders…: copies what differs between the two panes' folders. */
export function SyncDialog() {
  const { t } = useT();
  const pair = useApp((s) => s.syncPair);
  const close = () => useApp.getState().set({ syncPair: null });
  return (
    <Dialog
      open={!!pair}
      onClose={close}
      label={t("Synchronize Folders")}
      className="flex h-[78vh] w-[860px] max-w-[94vw] flex-col"
    >
      {pair && (
        <Body key={`${pair.left}\n${pair.right}`} left={pair.left} right={pair.right} onClose={close} />
      )}
    </Dialog>
  );
}

export interface SyncItem {
  rel: string;
  status: SyncStatus;
  left: SyncSide | null;
  right: SyncSide | null;
}

export type SyncAction = "toRight" | "toLeft" | "skip";
export type SyncDirection = "both" | "toRight" | "toLeft";

/** What a difference turns into for a direction; nothing is ever deleted. */
export function defaultAction(status: SyncStatus, direction: SyncDirection): SyncAction {
  if (direction === "toRight") return status === "rightOnly" ? "skip" : "toRight";
  if (direction === "toLeft") return status === "leftOnly" ? "skip" : "toLeft";
  if (status === "leftOnly" || status === "leftNewer") return "toRight";
  if (status === "rightOnly" || status === "rightNewer") return "toLeft";
  return "skip";
}

const NEXT: Record<SyncAction, SyncAction> = { toRight: "toLeft", toLeft: "skip", skip: "toRight" };

export function join(root: string, rel: string): string {
  return `${root === "/" ? "" : root}/${rel}`;
}

/** Rows drawn at most; the rest still take part in the synchronization. */
const SHOWN = 3000;

interface Scan {
  /** Which comparison mode and run these results belong to. */
  key: string;
  run: string;
  items: SyncItem[];
  folders: number;
  done: boolean;
}

const fresh = (key: string, run = ""): Scan => ({ key, run, items: [], folders: 0, done: false });

/** Streams the differences; a new comparison (other mode) starts from an empty list. */
function useComparison(left: string, right: string, byContent: boolean): Scan {
  const key = String(byContent);
  const [state, setScan] = useState<Scan>(fresh(key));
  // Messages of a cancelled run can still arrive; only the latest run counts.
  const latest = useRef("");
  useEffect(() => {
    const id = crypto.randomUUID();
    latest.current = id;
    const channel = new Channel<SyncEvent>();
    const current = (s: Scan) => (s.run === id ? s : fresh(key, id));
    channel.onmessage = (ev) =>
      setScan((prev) => {
        if (latest.current !== id) return prev;
        const s = current(prev);
        return ev.type === "item"
          ? {
              ...s,
              items: [
                ...s.items,
                { rel: ev.rel, status: ev.status, left: ev.left ?? null, right: ev.right ?? null },
              ],
            }
          : ev.type === "progress"
            ? { ...s, folders: ev.folders }
            : { ...s, done: true };
      });
    void commands.compareFolders(id, left, right, byContent, channel).then((r) => {
      if (r.status === "error" && latest.current === id) setScan((s) => ({ ...current(s), done: true }));
    });
    return () => void commands.cancelJob(id);
  }, [left, right, byContent, key]);
  return state.key === key ? state : fresh(key);
}

const DIRECTIONS = [
  ["both", msg("Both Ways")],
  ["toRight", msg("Left to Right")],
  ["toLeft", msg("Right to Left")],
] as const;

function Body({ left, right, onClose }: { left: string; right: string; onClose: () => void }) {
  const { t, tn } = useT();
  const [byContent, setByContent] = useState(false);
  const scan = useComparison(left, right, byContent);
  const [direction, setDirection] = useState<SyncDirection>("both");
  // Only the rows the user changed by hand; the rest follow the direction.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, SyncAction>>(new Map());
  const action = (item: SyncItem) => overrides.get(item.rel) ?? defaultAction(item.status, direction);

  const plan = scan.items.map((item) => ({ item, act: action(item) }));
  const toRight = plan.filter((p) => p.act === "toRight");
  const toLeft = plan.filter((p) => p.act === "toLeft");

  const cycle = (item: SyncItem) => setOverrides((prev) => new Map(prev).set(item.rel, NEXT[action(item)]));

  const run = () => {
    const items = plan.flatMap(({ item, act }) =>
      act === "toRight"
        ? [{ source: join(left, item.rel), dest: join(right, item.rel) }]
        : act === "toLeft"
          ? [{ source: join(right, item.rel), dest: join(left, item.rel) }]
          : [],
    );
    onClose();
    void runJob({ kind: "sync", items });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[13px]">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate font-semibold">
            {t("“{left}” and “{right}”", { left: basename(left), right: basename(right) })}
          </p>
          <p className="m-0 text-[12px] text-fg-muted">
            {scan.done
              ? scan.items.length === 0
                ? t("The folders are the same.")
                : tn(scan.items.length, "1 difference", "{count} differences")
              : t("Comparing… {count} folders", { count: scan.folders.toLocaleString() })}
          </p>
        </div>
        <label
          className="flex items-center gap-1.5 text-[12px] text-fg-muted"
          title={t("Reads files of the same size, so copies with other dates don’t count as different.")}
        >
          <input type="checkbox" checked={byContent} onChange={(e) => setByContent(e.target.checked)} />
          {t("Compare Contents")}
        </label>
        <fieldset aria-label={t("Direction")} className="m-0 flex gap-0.5 border-0 p-0">
          {DIRECTIONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={direction === value}
              onClick={() => {
                setDirection(value);
                setOverrides(new Map());
              }}
              className={`h-6 rounded-md px-2.5 text-[12px] ${direction === value ? "bg-sidebar-active text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {t(label)}
            </button>
          ))}
        </fieldset>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed border-collapse text-[12px]">
          <thead className="sticky top-0 bg-bg-alt text-[11px] text-fg-muted">
            <tr>
              <th className="px-3 py-1 text-left font-medium">{t("Name")}</th>
              <th className="w-[150px] px-2 py-1 text-right font-medium">{basename(left)}</th>
              <th className="w-[44px] py-1" aria-label={t("Action")} />
              <th className="w-[150px] px-2 py-1 text-left font-medium">{basename(right)}</th>
            </tr>
          </thead>
          <tbody>
            {plan.slice(0, SHOWN).map(({ item, act }) => (
              <tr key={item.rel} className="border-b border-border/50">
                <td className="truncate px-3 py-0.5" title={item.rel}>
                  {item.rel}
                </td>
                <td className="px-2 py-0.5 text-right text-fg-muted">
                  <Side side={item.left} />
                </td>
                <td className="py-0.5 text-center">
                  <button
                    type="button"
                    onClick={() => cycle(item)}
                    title={t("Change what happens")}
                    aria-label={
                      act === "toRight"
                        ? t("Copy to the right")
                        : act === "toLeft"
                          ? t("Copy to the left")
                          : t("Leave as is")
                    }
                    className={`inline-flex size-6 items-center justify-center rounded-md hover:bg-hover ${act === "skip" ? "text-fg-faint" : "text-accent"}`}
                  >
                    {act === "toRight" ? (
                      <ArrowRight size={14} />
                    ) : act === "toLeft" ? (
                      <ArrowLeft size={14} />
                    ) : (
                      <Equal size={14} />
                    )}
                  </button>
                </td>
                <td className="px-2 py-0.5 text-fg-muted">
                  <Side side={item.right} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {plan.length > SHOWN && (
          <p className="px-3 py-2 text-[12px] text-fg-faint">
            {t("and {count} more", { count: (plan.length - SHOWN).toLocaleString() })}
          </p>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
        <span className="flex-1 text-[12px] text-fg-muted">
          {t("{right} to the right, {left} to the left. Replaced items go to the Trash.", {
            right: toRight.length.toLocaleString(),
            left: toLeft.length.toLocaleString(),
          })}
        </span>
        <DialogButton onClick={onClose}>{t("Cancel")}</DialogButton>
        <DialogButton primary disabled={!scan.done || toRight.length + toLeft.length === 0} onClick={run}>
          {t("Synchronize")}
        </DialogButton>
      </footer>
    </div>
  );
}

function Side({ side }: { side: SyncSide | null }) {
  const { t } = useT();
  if (!side) return <span className="text-fg-faint">—</span>;
  return (
    <span className="block truncate">
      {side.dir ? t("Folder") : formatSize(side.size)} · {formatDate(side.modifiedMs ?? 0)}
    </span>
  );
}
