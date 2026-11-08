/**
 * Collects streamed messages and hands them over in batches, so a dialog that
 * receives thousands of results renders a few times a second instead of once
 * per message, and copies its list once per batch instead of once per item.
 * A timer is used rather than an animation frame: hidden windows get none.
 */
export interface Batcher<T> {
  push: (value: T) => void;
  /** Hands over what's waiting now (e.g. when the run ends). */
  flush: () => void;
  /** Drops what's waiting; nothing is handed over afterwards. */
  cancel: () => void;
}

export function batcher<T>(deliver: (values: T[]) => void, delayMs = 50): Batcher<T> {
  let waiting: T[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (cancelled || waiting.length === 0) return;
    const values = waiting;
    waiting = [];
    deliver(values);
  };
  return {
    push(value) {
      if (cancelled) return;
      waiting.push(value);
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      waiting = [];
    },
  };
}
