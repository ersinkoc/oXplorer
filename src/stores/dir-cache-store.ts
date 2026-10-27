import { Channel } from "@tauri-apps/api/core";
import { debug } from "@tauri-apps/plugin-log";
import { create } from "zustand";
import type { FinderTag } from "@/bindings";
import {
  commands,
  type DirChanged_Serialize as DirChanged,
  type DirEvent_Serialize as DirEvent,
  type DirEvent_Deserialize,
} from "@/bindings";
import { type AppError, type FileEntry, toAppError, unwrap } from "@/lib/ipc";

export type DirStatus = "loading" | "ready" | "error";

export interface DirState {
  status: DirStatus;
  entries: FileEntry[];
  error: AppError | null;
}

interface DirCacheState {
  dirs: Record<string, DirState>;
  load: (path: string) => Promise<void>;
  /** Applies a watcher delta; changes that land mid-listing are replayed after it. */
  applyChange: (change: DirChanged) => void;
}

/** Sets Finder tags (streamed after a listing completes) on the matching entries. */
export function applyTags(
  entries: readonly FileEntry[],
  tags: ReadonlyMap<string, FinderTag[]>,
): FileEntry[] {
  if (tags.size === 0) return entries as FileEntry[];
  return entries.map((e) => {
    const t = tags.get(e.path);
    return t ? { ...e, tags: t } : e;
  });
}

/** Pure delta application: removals and replacements by path, then additions. */
export function applyDelta(entries: readonly FileEntry[], change: DirChanged): FileEntry[] {
  if (change.removed.length === 0 && change.upserted.length === 0) return entries as FileEntry[];
  const drop = new Set(change.removed);
  for (const e of change.upserted) drop.add(e.path);
  return entries.filter((e) => !drop.has(e.path)).concat(change.upserted);
}

/**
 * During a first load the list re-renders (and re-sorts) on each flush, so after
 * the first batch paints, further flushes are spaced out; the rest lands at `done`.
 */
const FLUSH_MS = 400;

/** Monotonic per-path load ids; a newer load makes older channels' messages no-ops. */
const loadIds = new Map<string, number>();
/** Watcher deltas received while a path was still being listed. */
const deferred = new Map<string, DirChanged[]>();

export const useDirCache = create<DirCacheState>()((set, get) => {
  const patch = (path: string, next: Partial<DirState>) =>
    set((s) => {
      const prev = s.dirs[path] ?? { status: "loading", entries: [], error: null };
      return { dirs: { ...s.dirs, [path]: { ...prev, ...next } } };
    });

  return {
    dirs: {},

    load: async (path) => {
      const id = (loadIds.get(path) ?? 0) + 1;
      loadIds.set(path, id);
      const current = () => loadIds.get(path) === id;

      // A reload keeps showing the old listing and swaps atomically at the end;
      // a first load streams in so large folders paint immediately.
      const progressive = (get().dirs[path]?.entries.length ?? 0) === 0;
      patch(path, progressive ? { status: "loading", error: null, entries: [] } : { error: null });

      const started = performance.now();
      let firstBatchMs = -1;
      const buffer: FileEntry[] = [];
      let lastFlush = 0;
      const flush = () => {
        lastFlush = performance.now();
        patch(path, { entries: buffer.slice() });
      };

      // tauri-specta types channel params with the *Deserialize* shape; the payload Rust
      // actually sends is the Serialize shape (all fields present), hence the cast.
      // Channel messages can arrive *after* the command's promise resolves, so
      // completion is signalled by the in-order `done` event, not by the invoke.
      let markDone: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        markDone = resolve;
      });
      // Tags arrive after `done`; hold them until the listing is in the store.
      let pendingTags: Map<string, FinderTag[]> | null = new Map();
      const channel = new Channel<DirEvent_Deserialize>();
      channel.onmessage = (raw) => {
        const ev = raw as DirEvent;
        if (ev.type === "done") markDone();
        if (!current()) return;
        if (ev.type === "tags") {
          const map = new Map(ev.entries.map((t) => [t.path, t.tags]));
          if (pendingTags) for (const [k, v] of map) pendingTags.set(k, v);
          else {
            const dir = get().dirs[path];
            if (dir) patch(path, { entries: applyTags(dir.entries, map) });
          }
        } else if (ev.type === "batch") {
          if (firstBatchMs < 0) firstBatchMs = performance.now() - started;
          for (const e of ev.entries) buffer.push(e);
          if (progressive && (lastFlush === 0 || performance.now() - lastFlush >= FLUSH_MS)) flush();
        }
      };

      // The command only returns after the (slow) tag phase, so readiness keys off
      // `done`; a rejection before `done` is a real listing error.
      const invoke = unwrap(commands.openDir(path, channel));
      invoke.catch((err: unknown) => void debug(`list ${path} ended: ${toAppError(err).kind}`));
      try {
        await Promise.race([done, invoke.then(() => done)]);
        if (!current()) return;
        const queued = deferred.get(path) ?? [];
        deferred.delete(path);
        const tags = pendingTags;
        pendingTags = null;
        patch(path, { status: "ready", entries: applyTags(queued.reduce(applyDelta, buffer), tags) });
        const total = Math.round(performance.now() - started);
        void debug(
          `listed ${path}: ${buffer.length} entries, first batch ${Math.round(firstBatchMs)}ms, total ${total}ms`,
        );
      } catch (err) {
        const error = toAppError(err);
        if (current()) patch(path, { status: "error", error, entries: [] });
        void debug(`list ${path} failed: ${error.kind}`);
      }
    },

    applyChange: (change) => {
      const dir = get().dirs[change.dir];
      if (!dir) return;
      void debug(
        `delta ${change.dir}: +${change.upserted.length} -${change.removed.length}${change.rescan ? " rescan" : ""}`,
      );
      if (change.rescan) {
        void get().load(change.dir);
      } else if (dir.status === "loading") {
        deferred.set(change.dir, [...(deferred.get(change.dir) ?? []), change]);
      } else if (dir.status === "ready") {
        patch(change.dir, { entries: applyDelta(dir.entries, change) });
      }
    },
  };
});
