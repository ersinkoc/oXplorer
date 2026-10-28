import { Channel } from "@tauri-apps/api/core";
import { debug } from "@tauri-apps/plugin-log";
import { create } from "zustand";
import type { FinderTag } from "@/bindings";
import {
  type ContentMatch,
  commands,
  type DirChanged_Serialize as DirChanged,
  type DirEvent_Serialize as DirEvent,
  type DirEvent_Deserialize,
  type SearchEvent_Deserialize,
  type SearchEvent_Serialize,
} from "@/bindings";
import { isArchivePath } from "@/lib/archive-path";
import { type AppError, type FileEntry, toAppError, unwrap } from "@/lib/ipc";
import { parent } from "@/lib/path";
import { isSearchPath, parseSearchPath } from "@/lib/search-path";
import { EMPTY_SEARCH, useSearchInfo } from "@/stores/search-store";

export type DirStatus = "loading" | "ready" | "error";

export interface DirState {
  status: DirStatus;
  entries: FileEntry[];
  error: AppError | null;
}

interface DirCacheState {
  dirs: Record<string, DirState>;
  /** Lists a folder, or runs the search a `search:` path describes. */
  load: (path: string) => Promise<void>;
  /** Stops a running search (no-op for folders). */
  stop: (path: string) => void;
  /** File operations outside a search still show up in its results. */
  applyToSearches: (created: readonly FileEntry[], removed: readonly string[]) => void;
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

/** Ids of running searches by path, for cancelling. */
const searchIds = new Map<string, string>();

/** Monotonic per-path load ids; a newer load makes older channels' messages no-ops. */
const loadIds = new Map<string, number>();
/** Watcher deltas received while a path was still being listed. */
const deferred = new Map<string, DirChanged[]>();

export const useDirCache = create<DirCacheState>()((set, get) => {
  /** An archive's folder: listed in one go (Rust caches the archive's directory). */
  const listArchive = async (path: string): Promise<void> => {
    const id = (loadIds.get(path) ?? 0) + 1;
    loadIds.set(path, id);
    if (!get().dirs[path]) patch(path, { status: "loading", entries: [], error: null });
    try {
      const entries = await unwrap(commands.archiveList(path));
      if (loadIds.get(path) === id) patch(path, { status: "ready", entries, error: null });
    } catch (err) {
      if (loadIds.get(path) === id) patch(path, { status: "error", error: toAppError(err), entries: [] });
    }
  };

  /** Streams a search into `dirs[path]` like a folder listing. */
  const runSearch = async (path: string): Promise<void> => {
    get().stop(path);
    const spec = parseSearchPath(path);
    const info = useSearchInfo.getState();
    if (!spec?.query.trim()) {
      info.patch(path, { ...EMPTY_SEARCH });
      patch(path, { status: "ready", entries: [], error: null });
      return;
    }
    const id = crypto.randomUUID();
    searchIds.set(path, id);
    const current = () => searchIds.get(path) === id;
    info.patch(path, { matches: new Map(), scanned: 0, running: true, outcome: null });
    patch(path, { status: "loading", entries: [], error: null });

    const buffer: FileEntry[] = [];
    const matches = new Map<string, ContentMatch>();
    let lastFlush = 0;
    const flush = () => {
      lastFlush = performance.now();
      patch(path, { entries: buffer.slice() });
      useSearchInfo.getState().patch(path, { matches: new Map(matches) });
    };
    const channel = new Channel<SearchEvent_Deserialize>();
    channel.onmessage = (raw) => {
      if (!current()) return;
      const ev = raw as SearchEvent_Serialize;
      if (ev.type === "batch") {
        for (const e of ev.entries) buffer.push(e);
        for (const m of ev.matches) matches.set(m.path, m);
        if (lastFlush === 0 || performance.now() - lastFlush >= FLUSH_MS) flush();
      } else if (ev.type === "progress") {
        useSearchInfo.getState().patch(path, { scanned: ev.scanned });
      } else {
        searchIds.delete(path);
        flush();
        patch(path, { status: "ready" });
        useSearchInfo.getState().patch(path, { running: false, outcome: ev });
        void debug(
          `search ${spec.mode} "${spec.query}": ${ev.total} results${ev.cancelled ? " (cancelled)" : ""}`,
        );
      }
    };
    try {
      await unwrap(commands.searchStart(id, spec, channel));
    } catch (err) {
      if (!current()) return;
      searchIds.delete(path);
      useSearchInfo.getState().patch(path, { running: false });
      patch(path, { status: "error", error: toAppError(err), entries: [] });
    }
  };

  const patch = (path: string, next: Partial<DirState>) =>
    set((s) => {
      const prev = s.dirs[path] ?? { status: "loading", entries: [], error: null };
      return { dirs: { ...s.dirs, [path]: { ...prev, ...next } } };
    });

  return {
    dirs: {},

    load: async (path) => {
      if (isSearchPath(path)) return runSearch(path);
      if (isArchivePath(path)) return listArchive(path);
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

    stop: (path) => {
      const id = searchIds.get(path);
      if (!id) return;
      searchIds.delete(path);
      void commands.searchCancel(id);
      // The UI stops at once; the engine may need a moment to wind down.
      const info = useSearchInfo.getState().searches[path];
      useSearchInfo.getState().patch(path, {
        running: false,
        outcome: info?.outcome ?? {
          total: get().dirs[path]?.entries.length ?? 0,
          cancelled: true,
          truncated: false,
        },
      });
      patch(path, { status: "ready" });
    },

    applyToSearches: (created, removed) => {
      const gone = new Set(removed);
      const changed = new Set(created.map((e) => e.path));
      for (const [path, dir] of Object.entries(get().dirs)) {
        if (!isSearchPath(path)) continue;
        if (!dir.entries.some((e) => gone.has(e.path) || changed.has(e.path))) continue;
        // Renamed or moved results stay in the list under their new path; results
        // that changed in place (tags) are refreshed.
        const folders = new Set(dir.entries.filter((e) => gone.has(e.path)).map((e) => parent(e.path)));
        const shown = new Set(dir.entries.map((e) => e.path));
        const replacements = created.filter((e) => folders.has(parent(e.path)) || shown.has(e.path));
        patch(path, {
          entries: applyDelta(dir.entries, {
            dir: path,
            upserted: replacements,
            removed: [...removed],
            rescan: false,
          }),
        });
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
