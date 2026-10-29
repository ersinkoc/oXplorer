import { Channel } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { toast } from "sonner";
import {
  type ConflictResolution,
  commands,
  type JobEvent_Serialize as JobEvent,
  type JobEvent_Deserialize,
  type JobOutcome_Serialize as JobOutcome,
  type JobSpec,
  type UndoAction,
} from "@/bindings";
import { msg, t, tn } from "@/i18n";
import { describeError, type FileEntry, unwrap } from "@/lib/ipc";
import { parent } from "@/lib/path";
import { useDirCache } from "@/stores/dir-cache-store";
import { useHistory } from "@/stores/history-store";
import { useJobs } from "@/stores/jobs-store";
import { getActiveTab, useWorkspace, visiblePanes } from "@/stores/workspace-store";

export type HistoryMode = "record" | "undo" | "redo" | "none";

/** Progress labels, translated where they're shown. */
const LABELS: Record<JobSpec["kind"], string> = {
  copy: msg("Copying"),
  move: msg("Moving"),
  duplicate: msg("Duplicating"),
  trash: msg("Moving to Trash"),
  delete: msg("Deleting"),
  compress: msg("Compressing"),
  extract: msg("Extracting"),
  extractMembers: msg("Copying"),
  download: msg("Downloading"),
  upload: msg("Uploading"),
  sync: msg("Synchronizing"),
  undo: msg("Undoing"),
};

/**
 * Runs a file job in Rust and folds its outcome back into the UI: directory
 * caches update immediately (the watcher confirms later), created items get
 * selected, and the undo/redo stacks advance.
 */
export async function runJob(
  spec: JobSpec,
  opts: { history?: HistoryMode; select?: boolean } = {},
): Promise<JobOutcome | null> {
  const id = crypto.randomUUID();
  const label = spec.kind === "undo" ? spec.action.label : LABELS[spec.kind];
  useJobs.setState((s) => ({
    jobs: {
      ...s.jobs,
      [id]: {
        id,
        label,
        startedAt: performance.now(),
        totalBytes: 0,
        totalItems: 0,
        doneBytes: 0,
        doneItems: 0,
        current: "",
        conflict: null,
        paused: false,
        pausable:
          spec.kind === "copy" || spec.kind === "move" || spec.kind === "duplicate" || spec.kind === "sync",
      },
    },
  }));

  let finish: (o: JobOutcome) => void = () => {};
  const finished = new Promise<JobOutcome>((resolve) => {
    finish = resolve;
  });
  // Typed with the Deserialize shape by tauri-specta; Rust sends the Serialize shape.
  const channel = new Channel<JobEvent_Deserialize>();
  channel.onmessage = (raw) => {
    const ev = raw as JobEvent;
    const { update } = useJobs.getState();
    switch (ev.type) {
      case "planned":
        update(id, { totalBytes: ev.totalBytes, totalItems: ev.totalItems });
        break;
      case "progress":
        update(id, { doneBytes: ev.doneBytes, doneItems: ev.doneItems, current: ev.current });
        break;
      case "conflict":
        update(id, { conflict: { source: ev.source, existing: ev.existing } });
        break;
      case "finished":
        finish(ev.outcome);
        break;
    }
  };

  try {
    await unwrap(commands.startJob(id, spec, channel));
  } catch (err) {
    useJobs.getState().remove(id);
    toast.error(err instanceof Error ? err.message : String(err));
    return null;
  }
  const outcome = await finished;
  // Servers aren't watched: show what was uploaded.
  if (spec.kind === "upload") void useDirCache.getState().load(spec.destDir);
  const elapsed = performance.now() - (useJobs.getState().jobs[id]?.startedAt ?? performance.now());
  useJobs.getState().remove(id);
  applyOutcome(outcome, opts);
  if (elapsed >= NOTIFY_AFTER_MS && !document.hasFocus())
    void notifyFinished(spec.kind === "undo" ? spec.action.label : NOUNS[spec.kind], outcome);
  return outcome;
}

/** Notification titles: "Copy finished". */
const NOUNS: Record<Exclude<JobSpec["kind"], "undo">, string> = {
  copy: msg("Copy"),
  move: msg("Move"),
  duplicate: msg("Duplicate"),
  trash: msg("Move to Trash"),
  delete: msg("Delete"),
  compress: msg("Compress"),
  extract: msg("Extract"),
  extractMembers: msg("Copy"),
  download: msg("Download"),
  upload: msg("Upload"),
  sync: msg("Synchronize"),
};

/** Jobs that ran this long get a system notification when OXplorer isn't in front. */
const NOTIFY_AFTER_MS = 10_000;

async function notifyFinished(label: string, outcome: JobOutcome): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    const failed = outcome.failures.length;
    const action = t(label);
    sendNotification({
      title: outcome.cancelled
        ? t("{action} stopped", { action })
        : failed > 0
          ? t("{action} finished with problems", { action })
          : t("{action} finished", { action }),
      body:
        failed > 0
          ? tn(failed, "{count} item couldn’t be processed.", "{count} items couldn’t be processed.")
          : tn(outcome.created.length + outcome.removed.length, "{count} item", "{count} items"),
    });
  } catch (err) {
    console.warn("notification failed", err);
  }
}

export function resolveConflict(id: string, resolution: ConflictResolution): void {
  useJobs.getState().update(id, { conflict: null });
  void commands.resolveConflict(id, resolution);
}

export function cancelJob(id: string): void {
  void commands.cancelJob(id);
}

export function pauseJob(id: string, paused: boolean): void {
  useJobs.getState().update(id, { paused });
  void commands.pauseJob(id, paused);
}

function groupByParent<T>(items: readonly T[], pathOf: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const dir = parent(pathOf(item)) ?? "/";
    out.set(dir, [...(out.get(dir) ?? []), item]);
  }
  return out;
}

/** Applies created/removed items to cached listings without waiting for the watcher. */
export function applyFsChanges(created: readonly FileEntry[], removed: readonly string[]): void {
  const cache = useDirCache.getState();
  cache.applyToSearches(created, removed);
  const dirs = new Set([
    ...groupByParent(created, (e) => e.path).keys(),
    ...groupByParent(removed, (p) => p).keys(),
  ]);
  const createdBy = groupByParent(created, (e) => e.path);
  const removedBy = groupByParent(removed, (p) => p);
  for (const dir of dirs) {
    cache.applyChange({
      dir,
      upserted: createdBy.get(dir) ?? [],
      removed: removedBy.get(dir) ?? [],
      rescan: false,
    });
  }
}

export function recordUndo(action: UndoAction | null | undefined, mode: HistoryMode = "record"): void {
  if (!action || mode === "none") return;
  const h = useHistory.getState();
  if (mode === "record") h.record(action);
  else if (mode === "undo") h.set({ redo: [...h.redo, action] });
  else h.set({ undo: [...h.undo, action] });
}

function applyOutcome(outcome: JobOutcome, opts: { history?: HistoryMode; select?: boolean }): void {
  applyFsChanges(outcome.created, outcome.removed);
  recordUndo(outcome.undo, opts.history ?? "record");

  // Created items get selected in every visible pane that shows their folder.
  for (const pane of opts.select === false ? [] : visiblePanes(useWorkspace.getState())) {
    const here = getActiveTab(pane).path;
    const mine = outcome.created.filter((e) => parent(e.path) === here).map((e) => e.path);
    if (mine.length === 0) continue;
    useWorkspace
      .getState()
      .setSelection({ paths: new Set(mine), anchor: mine[0] ?? null, focus: mine.at(-1) ?? null }, pane);
  }

  const [first] = outcome.failures;
  if (first) {
    const more = outcome.failures.length - 1;
    toast.error(describeError(first.error), {
      description:
        more > 0
          ? tn(
              more,
              "…and {count} more item couldn’t be processed.",
              "…and {count} more items couldn’t be processed.",
            )
          : undefined,
    });
  }
}
