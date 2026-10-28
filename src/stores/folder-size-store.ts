import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { commands, type MeasureEvent } from "@/bindings";

/** Total size of what's in a folder; `done` once the walk finished. */
export interface FolderSize {
  bytes: number;
  done: boolean;
}

/**
 * Sizes from View → Calculate Folder Sizes, by path. They're kept until the
 * folder is reloaded (⌘R), like Total Commander's.
 */
export const useFolderSizes = create<{ sizes: Record<string, FolderSize> }>()(() => ({ sizes: {} }));

const queue: string[] = [];
/** The measurement in flight; `stop` cancels it and settles its promise. */
let current: { id: string; stop: () => void } | null = null;

function measureOne(path: string): Promise<void> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const channel = new Channel<MeasureEvent>();
    let live = true;
    const finish = () => {
      live = false;
      current = null;
      resolve();
    };
    current = {
      id,
      stop: () => {
        void commands.cancelJob(id);
        finish();
      },
    };
    channel.onmessage = (ev) => {
      if (!live) return;
      useFolderSizes.setState((s) => ({
        sizes: { ...s.sizes, [path]: { bytes: ev.size.bytes, done: ev.type === "done" } },
      }));
      if (ev.type === "done") finish();
    };
    void commands.measure(id, [path], channel).then((r) => {
      if (r.status === "error") finish();
    });
  });
}

/** Measures `paths` one after another (the disk is the limit, not the CPU). */
export async function measureFolders(paths: readonly string[]): Promise<void> {
  const { sizes } = useFolderSizes.getState();
  for (const p of paths) if (!sizes[p]?.done && !queue.includes(p)) queue.push(p);
  if (current) return;
  for (let next = queue.shift(); next; next = queue.shift()) await measureOne(next);
}

/** Forgets sizes inside `folder` and stops measuring. */
export function clearFolderSizes(folder: string): void {
  queue.length = 0;
  current?.stop();
  const prefix = folder.endsWith("/") ? folder : `${folder}/`;
  useFolderSizes.setState((s) => ({
    sizes: Object.fromEntries(Object.entries(s.sizes).filter(([p]) => !p.startsWith(prefix))),
  }));
}
