import { describe, expect, it } from "vitest";
import { globMatcher } from "@/lib/glob";
import { locationTitle } from "@/lib/location-title";
import { mirrorMove } from "@/lib/path";
import { moveToGap } from "@/lib/reorder";
import { EMPTY_SELECTION, invert, selectOne, selectWhere } from "@/lib/selection";

describe("globMatcher", () => {
  it("matches wildcards, lists and plain text", () => {
    const m = globMatcher("*.JPG; *.png, a?c");
    expect(m).not.toBeNull();
    expect(m?.("photo.jpg")).toBe(true);
    expect(m?.("Icon.PNG")).toBe(true);
    expect(m?.("abc")).toBe(true);
    expect(m?.("abbc")).toBe(false);
    expect(m?.("photo.jpg.txt")).toBe(false);
    expect(globMatcher("port")?.("Report.pdf")).toBe(true);
    // Without wildcards a comma is part of the name.
    expect(globMatcher("Smith, John")?.("Smith, John.pdf")).toBe(true);
    expect(globMatcher("Smith, John")?.("John.pdf")).toBe(false);
  });

  it("treats regex characters literally and ignores normalization", () => {
    expect(globMatcher("a+b (1)*")?.("a+b (1) copy")).toBe(true);
    expect(globMatcher("a+b")?.("aab")).toBe(false);
    expect(globMatcher("café*")?.("café.txt")).toBe(true);
  });

  it("returns null for an empty pattern", () => {
    expect(globMatcher(" ; ,")).toBeNull();
  });
});

describe("selection helpers", () => {
  const order = ["/a", "/b", "/c", "/d"];

  it("inverts within the visible items", () => {
    const s = invert({ ...selectOne("/b"), paths: new Set(["/b", "/x"]) }, order);
    expect([...s.paths]).toEqual(["/a", "/c", "/d"]);
    expect(s.focus).toBe("/a");
  });

  it("adds and removes matches", () => {
    const added = selectWhere(selectOne("/a"), order, (p) => p > "/b", true);
    expect([...added.paths].sort()).toEqual(["/a", "/c", "/d"]);
    expect(added.focus).toBe("/c");
    const removed = selectWhere(added, order, (p) => p === "/c", false);
    expect([...removed.paths].sort()).toEqual(["/a", "/d"]);
    expect(removed.focus).toBeNull();
    expect(selectWhere(EMPTY_SELECTION, order, () => false, true).paths.size).toBe(0);
  });
});

describe("locationTitle", () => {
  it("names folders, the disk and servers", () => {
    const conns = [{ id: "c1", name: "NAS" }] as unknown as Parameters<typeof locationTitle>[1];
    expect(locationTitle("/Users/me/Work", conns)).toBe("Work");
    expect(locationTitle("/", conns)).toBe("Macintosh HD");
    expect(locationTitle("remote:c1/", conns)).toBe("NAS");
  });
});

describe("moveToGap", () => {
  it("moves items into gaps", () => {
    expect(moveToGap(["a", "b", "c"], 0, 3)).toEqual(["b", "c", "a"]);
    expect(moveToGap(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveToGap(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
    expect(moveToGap(["a", "b", "c"], 1, 2)).toEqual(["a", "b", "c"]);
    expect(moveToGap(["a", "b", "c"], 5, 0)).toEqual(["a", "b", "c"]);
  });
});

describe("mirrorMove", () => {
  it("follows into subfolders and up", () => {
    expect(mirrorMove("/a", "/a/src", "/b")).toBe("/b/src");
    expect(mirrorMove("/", "/Users", "/Volumes/X")).toBe("/Volumes/X/Users");
    expect(mirrorMove("/a/src", "/a", "/b/src")).toBe("/b");
    expect(mirrorMove("/a/src", "/a", "/")).toBeNull();
    expect(mirrorMove("/a", "/c/d", "/b")).toBeNull();
  });
});
