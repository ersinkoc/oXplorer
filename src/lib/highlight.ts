import type { HighlightRequest, HighlightResponse } from "@/workers/highlight.worker";

/** A pathological file can't keep the worker busy forever: it's replaced. */
const TIMEOUT_MS = 3000;
/** Beyond this, the preview stays plain text (it's only the head of the file anyway). */
export const HIGHLIGHT_MAX_CHARS = 128 * 1024;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (html: string | null) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("../workers/highlight.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<HighlightResponse>) => {
    pending.get(e.data.id)?.(e.data.html);
    pending.delete(e.data.id);
  };
  worker = w;
  return w;
}

function restartWorker(): void {
  worker?.terminate();
  worker = null;
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}

/** Highlighted HTML for `text` (shiki, in a worker), or null to show it plain. */
export function highlight(fileName: string, text: string): Promise<string | null> {
  if (text.length > HIGHLIGHT_MAX_CHARS) return Promise.resolve(null);
  seq += 1;
  const id = seq;
  return new Promise((resolve) => {
    const timer = setTimeout(restartWorker, TIMEOUT_MS);
    pending.set(id, (html) => {
      clearTimeout(timer);
      resolve(html);
    });
    getWorker().postMessage({ id, fileName, text } satisfies HighlightRequest);
  });
}
