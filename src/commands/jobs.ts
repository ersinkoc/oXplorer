import { Channel } from "@tauri-apps/api/core";
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
import { describeError, type FileEntry, unwrap } from "@/lib/ipc";
import { parent } from "@/lib/path";
import { useDirCache } from "@/stores/dir-cache-store";
import { useHistory } from "@/stores/history-store";
import { useJobs } from "@/stores/jobs-store";
import { getActiveTab, useWorkspace, visiblePanes } from "@/stores/workspace-store";

export type HistoryMode = "record" | "undo" | "redo" | "none";

const LABELS: Record<JobSpec["kind"], string> = {
  copy: "Copying",
  move: "Moving",
  duplicate: "Duplicating",
  trash: "Moving to Trash",
  delete: "Deleting",
  compress: "Compressing",
  extract: "Extracting",
  undo: "Undoing",
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
  useJobs.getState().remove(id);
  applyOutcome(outcome, opts);
  return outcome;
}

export function resolveConflict(id: string, resolution: ConflictResolution): void {
  useJobs.getState().update(id, { conflict: null });
  void commands.resolveConflict(id, resolution);
}

export function cancelJob(id: string): void {
  void commands.cancelJob(id);
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
        more > 0 ? `…and ${more} more item${more === 1 ? "" : "s"} couldn’t be processed.` : undefined,
    });
  }
}
