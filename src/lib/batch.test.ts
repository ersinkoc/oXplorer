import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batcher } from "@/lib/batch";

describe("batcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands messages over in order, once per delay", () => {
    const got: number[][] = [];
    const b = batcher<number>((v) => got.push(v), 50);
    b.push(1);
    b.push(2);
    expect(got).toEqual([]);
    vi.advanceTimersByTime(50);
    b.push(3);
    vi.advanceTimersByTime(50);
    expect(got).toEqual([[1, 2], [3]]);
  });

  it("flushes on demand and drops everything after cancel", () => {
    const got: number[][] = [];
    const b = batcher<number>((v) => got.push(v), 50);
    b.push(1);
    b.flush();
    b.flush();
    b.push(2);
    b.cancel();
    b.push(3);
    vi.advanceTimersByTime(100);
    expect(got).toEqual([[1]]);
  });
});
