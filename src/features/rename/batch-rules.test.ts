import { describe, expect, it } from "vitest";
import { findPattern, previewRenames, siblingKey, splitExtension } from "@/features/rename/batch-rules";

const files = ["IMG_001.jpg", "IMG_002.jpg", "notes.txt"].map((name) => ({
  path: `/d/${name}`,
  name,
  isFolder: false,
}));
const none = new Set<string>();

describe("batch rename rules", () => {
  it("splits extensions like Finder", () => {
    expect(splitExtension("a.tar.gz", false)).toEqual(["a.tar", ".gz"]);
    expect(splitExtension(".env", false)).toEqual([".env", ""]);
    expect(splitExtension("My.App", true)).toEqual(["My.App", ""]);
  });

  it("replaces text, literally or with a regex", () => {
    const r = previewRenames(
      files,
      { kind: "replace", find: "img_", replace: "Photo ", regex: false, caseSensitive: false },
      none,
    );
    expect(r.map((p) => p.newName)).toEqual(["Photo 001.jpg", "Photo 002.jpg", "notes.txt"]);
    const re = previewRenames(
      files,
      { kind: "replace", find: "_(\\d+)", replace: "-$1", regex: true, caseSensitive: true },
      none,
    );
    expect(re[0]?.newName).toBe("IMG-001.jpg");
    const literal = previewRenames(
      files,
      { kind: "replace", find: ".", replace: "!", regex: false, caseSensitive: true },
      none,
    );
    expect(literal[2]?.newName).toBe("notes!txt");
  });

  it("adds text before the extension and formats with counters", () => {
    const add = previewRenames(files, { kind: "add", text: " (old)", where: "after" }, none);
    expect(add[0]?.newName).toBe("IMG_001 (old).jpg");
    const fmt = previewRenames(
      files,
      { kind: "format", base: "Trip ", start: 9, digits: 3, where: "after" },
      none,
    );
    expect(fmt.map((p) => p.newName)).toEqual(["Trip 009.jpg", "Trip 010.jpg", "Trip 011.txt"]);
  });

  it("flags invalid, duplicate and taken names", () => {
    const dup = previewRenames(
      files.slice(0, 2),
      { kind: "format", base: "x", start: 1, digits: 1, where: "after" },
      none,
    );
    expect(dup.every((p) => p.problem === null)).toBe(true);
    const same = previewRenames(
      files.slice(0, 2),
      { kind: "replace", find: "\\d+", replace: "", regex: true, caseSensitive: true },
      none,
    );
    expect(same.every((p) => p.problem === "Same name as another item")).toBe(true);
    const slash = previewRenames(files, { kind: "add", text: "/", where: "before" }, none);
    expect(slash[0]?.problem).toBe("Contains “/”");
    const taken = previewRenames(
      files.slice(2),
      { kind: "replace", find: "notes", replace: "todo", regex: false, caseSensitive: true },
      new Set([siblingKey("/d", "todo.txt")]),
    );
    expect(taken[0]?.problem).toBe("An item with this name already exists");
    // A name freed by another item in the same batch is fine: x1→x2 while x2→x3.
    const shift = previewRenames(
      [
        { path: "/d/x1", name: "x1", isFolder: false },
        { path: "/d/x2", name: "x2", isFolder: false },
      ],
      { kind: "format", base: "x", start: 2, digits: 1, where: "after" },
      new Set([siblingKey("/d", "x1"), siblingKey("/d", "x2")]),
    );
    expect(shift.map((p) => [p.newName, p.problem])).toEqual([
      ["x2", null],
      ["x3", null],
    ]);
    // Search results from two folders: the same new name in each is fine.
    const twoFolders = previewRenames(
      [
        { path: "/a/a.txt", name: "a.txt", isFolder: false },
        { path: "/b/a.txt", name: "a.txt", isFolder: false },
      ],
      { kind: "add", text: "_old", where: "after" },
      new Set([siblingKey("/a", "a.txt"), siblingKey("/b", "a.txt")]),
    );
    expect(twoFolders.map((p) => p.problem)).toEqual([null, null]);
  });

  it("reports a bad regex without the engine's English prefix", () => {
    const bad = findPattern({ kind: "replace", find: "(a", replace: "", regex: true, caseSensitive: false });
    expect(typeof bad).toBe("string");
    expect(bad).not.toMatch(/Invalid regular expression/i);
    expect(
      findPattern({ kind: "replace", find: "(a", replace: "", regex: false, caseSensitive: false }),
    ).toBeInstanceOf(RegExp);
  });
});
