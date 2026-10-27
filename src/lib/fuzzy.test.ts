import { describe, expect, it } from "vitest";
import { fuzzyScore } from "@/lib/fuzzy";
import { frecency } from "@/stores/recents-store";

describe("fuzzyScore", () => {
  it("matches subsequences and prefers word starts and runs", () => {
    expect(fuzzyScore("nf", "New Folder")).not.toBeNull();
    expect(fuzzyScore("xyz", "New Folder")).toBeNull();
    const starts = fuzzyScore("nf", "New Folder") ?? 0;
    const inner = fuzzyScore("nf", "Info Panel") ?? 0;
    expect(starts).toBeGreaterThan(inner);
    const run = fuzzyScore("proj", "Projects") ?? 0;
    const spread = fuzzyScore("proj", "Pictures/Old/Junk") ?? 0;
    expect(run).toBeGreaterThan(spread);
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("frecency", () => {
  it("weights recent visits above old ones", () => {
    const now = Date.UTC(2026, 9, 27);
    const day = 86_400_000;
    const recent = frecency({ path: "/a", count: 3, last: now - day }, now);
    const old = frecency({ path: "/b", count: 3, last: now - 100 * day }, now);
    expect(recent).toBeGreaterThan(old);
    expect(frecency({ path: "/c", count: 10, last: now - 100 * day }, now)).toBeGreaterThan(old);
  });
});
