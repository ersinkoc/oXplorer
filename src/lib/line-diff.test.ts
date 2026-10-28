import { describe, expect, it } from "vitest";
import { type DiffLine, diffLines, withContext } from "@/lib/line-diff";

/** Applies the diff to rebuild both sides. */
function sides(d: DiffLine[]) {
  return {
    a: d.filter((l) => l.kind !== "add").map((l) => l.text),
    b: d.filter((l) => l.kind !== "del").map((l) => l.text),
  };
}

describe("diffLines", () => {
  it("finds a minimal edit and numbers lines", () => {
    const a = ["a", "b", "c", "a", "b", "b", "a"];
    const b = ["c", "b", "a", "b", "a", "c"];
    const d = diffLines(a, b);
    expect(d).not.toBeNull();
    if (!d) return;
    expect(sides(d)).toEqual({ a, b });
    expect(d.filter((l) => l.kind !== "same").length).toBe(5);
    expect(d.filter((l) => l.a !== null).map((l) => l.a)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("handles identical, empty and one-sided input", () => {
    expect(diffLines(["x"], ["x"])?.map((l) => l.kind)).toEqual(["same"]);
    expect(diffLines([], ["n"])?.map((l) => l.kind)).toEqual(["add"]);
    expect(diffLines(["o"], [])?.map((l) => l.kind)).toEqual(["del"]);
    expect(diffLines([], [])).toEqual([]);
  });

  it("round-trips random edits", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: rnd(30) }, () => String(rnd(5)));
      const b = Array.from({ length: rnd(30) }, () => String(rnd(5)));
      const d = diffLines(a, b);
      expect(d && sides(d)).toEqual({ a, b });
    }
  });

  it("gives up on huge differences", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(diffLines(a, b, 20)).toBeNull();
  });

  it("keeps context around changes", () => {
    const a = Array.from({ length: 20 }, (_, i) => String(i));
    const b = a.map((l) => (l === "10" ? "ten" : l));
    const shown = withContext(diffLines(a, b) ?? [], 2);
    expect(shown[0]).toBeNull();
    expect(shown.filter((l) => l !== null).map((l) => l.text)).toEqual(["8", "9", "10", "ten", "11", "12"]);
    expect(shown.at(-1)).toBeNull();
  });
});
