import { describe, expect, it } from "vitest";
import { compareEntries, differences } from "@/lib/compare";
import type { FileEntry } from "@/lib/ipc";

function e(name: string, modifiedMs: number, size = 10, kind: FileEntry["kind"] = "file"): FileEntry {
  return { name, path: `/x/${name}`, kind, modifiedMs, size } as FileEntry;
}

describe("compareEntries", () => {
  const left = [
    e("a.txt", 10_000),
    e("b.txt", 50_000),
    e("c.txt", 10_000, 5),
    e("same.txt", 10_000),
    e("dir", 0, 0, "dir"),
    e("Café", 1),
  ];
  const right = [
    e("b.txt", 10_000),
    e("c.txt", 10_500, 6),
    e("same.txt", 11_000),
    e("dir", 99_999, 0, "dir"),
    e("d.txt", 1),
    e("café", 1),
  ];

  it("marks both sides", () => {
    const m = compareEntries(left, right);
    expect(Object.fromEntries(m.left)).toEqual({
      "a.txt": "only",
      "b.txt": "newer",
      "c.txt": "different",
      "same.txt": "same",
      dir: "same",
      Café: "same",
    });
    expect(m.right.get("b.txt")).toBe("older");
    expect(m.right.get("d.txt")).toBe("only");
    expect(m.right.get("café")).toBe("same");
  });

  it("selects what should be copied across", () => {
    const m = compareEntries(left, right);
    expect([...differences(m.left)].sort()).toEqual(["a.txt", "b.txt"]);
    expect([...differences(m.right)]).toEqual(["d.txt"]);
  });
});
