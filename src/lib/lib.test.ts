import { describe, expect, it } from "vitest";
import { formatDate, formatDuration, kindLabel } from "@/lib/format";
import { iconUrl, thumbnailUrl } from "@/lib/icons";
import type { FileEntry } from "@/lib/ipc";
import { basename, normalizeUserInput, parent, segments, tildify } from "@/lib/path";
import { click, EMPTY_SELECTION, move, prune, selectAll, selectOne, typeAheadMatch } from "@/lib/selection";
import { DEFAULT_SORT, filterEntries, sortEntries } from "@/lib/sort";

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/d/${name}`,
    kind: "file",
    symlink: null,
    size: 0,
    allocated: 0,
    modifiedMs: 0,
    createdMs: null,
    accessedMs: null,
    mode: 0o644,
    uid: 501,
    gid: 20,
    inode: 1,
    isHidden: name.startsWith("."),
    isSystemJunk: name === ".DS_Store",
    extension: name.includes(".") ? (name.split(".").pop() ?? null) : null,
    tags: [],
    ...over,
  };
}

describe("path", () => {
  it("splits and joins", () => {
    expect(basename("/a/b")).toBe("b");
    expect(basename("/")).toBe("/");
    expect(parent("/a/b")).toBe("/a");
    expect(parent("/a")).toBe("/");
    expect(parent("/")).toBeNull();
    expect(segments("/Users/me").map((s) => s.path)).toEqual(["/", "/Users", "/Users/me"]);
  });

  it("normalizes user input", () => {
    expect(normalizeUserInput("~", "/Users/me")).toBe("/Users/me");
    expect(normalizeUserInput(" ~/Downloads/ ", "/Users/me")).toBe("/Users/me/Downloads");
    expect(normalizeUserInput("//tmp//x", "/h")).toBe("/tmp/x");
    expect(normalizeUserInput("relative", "/h")).toBeNull();
    expect(normalizeUserInput("", "/h")).toBeNull();
    expect(tildify("/Users/me/x", "/Users/me")).toBe("~/x");
    expect(tildify("/Users/meow", "/Users/me")).toBe("/Users/meow");
  });
});

describe("sort", () => {
  it("is natural, case-insensitive and keeps folders first", () => {
    const list = [entry("file10"), entry("File2"), entry("b", { kind: "dir" }), entry("a1")];
    expect(sortEntries(list, DEFAULT_SORT).map((e) => e.name)).toEqual(["b", "a1", "File2", "file10"]);
    expect(sortEntries(list, { ...DEFAULT_SORT, direction: "desc" }).map((e) => e.name)).toEqual([
      "b",
      "file10",
      "File2",
      "a1",
    ]);
  });

  it("sorts by size with name as tiebreaker", () => {
    const list = [entry("b", { size: 5 }), entry("a", { size: 5 }), entry("c", { size: 9 })];
    expect(
      sortEntries(list, { field: "size", direction: "asc", foldersFirst: true }).map((e) => e.name),
    ).toEqual(["a", "b", "c"]);
  });

  it("sorts folders by their measured size", () => {
    const list = [entry("x", { kind: "dir" }), entry("y", { kind: "dir" }), entry("z", { kind: "dir" })];
    const sizes = {
      "/d/x": { bytes: 5, done: true },
      "/d/y": { bytes: 9, done: true },
      "/d/z": { bytes: 99, done: false },
    };
    expect(
      sortEntries(list, { field: "size", direction: "desc", foldersFirst: true }, sizes).map((e) => e.name),
    ).toEqual(["y", "x", "z"]);
  });

  it("filters hidden, junk and by text", () => {
    const list = [entry(".env"), entry(".DS_Store"), entry("Readme.md"), entry("main.rs")];
    expect(filterEntries(list, { showHidden: false, filter: "" }).map((e) => e.name)).toEqual([
      "Readme.md",
      "main.rs",
    ]);
    expect(filterEntries(list, { showHidden: true, filter: "" }).map((e) => e.name)).toEqual([
      ".env",
      "Readme.md",
      "main.rs",
    ]);
    expect(filterEntries(list, { showHidden: true, filter: "README" }).map((e) => e.name)).toEqual([
      "Readme.md",
    ]);
  });
});

describe("selection", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("handles click modes", () => {
    let s = click(EMPTY_SELECTION, order, "b", "single");
    s = click(s, order, "d", "range");
    expect([...s.paths]).toEqual(["b", "c", "d"]);
    s = click(s, order, "c", "toggle");
    expect([...s.paths].sort()).toEqual(["b", "d"]);
    // Range re-anchors at the last toggled item.
    s = click(s, order, "e", "range");
    expect([...s.paths]).toEqual(["c", "d", "e"]);
  });

  it("moves with the keyboard and clamps", () => {
    let s = move(EMPTY_SELECTION, order, 1, false);
    expect(s.focus).toBe("a");
    s = move(s, order, 2, true);
    expect([...s.paths]).toEqual(["a", "b", "c"]);
    s = move(s, order, -1, true);
    expect([...s.paths]).toEqual(["a", "b"]);
    s = move(s, order, 100, false);
    expect(s.focus).toBe("e");
    expect(move(EMPTY_SELECTION, order, -1, false).focus).toBe("e");
  });

  it("prunes vanished paths but keeps identity when unchanged", () => {
    const s = selectAll(order);
    expect(prune(s, new Set(order))).toBe(s);
    const p = prune(selectOne("c"), new Set(["a"]));
    expect(p.paths.size).toBe(0);
    expect(p.focus).toBeNull();
  });

  it("type-ahead finds prefix or the next name", () => {
    const names = ["apple", "Banana", "cherry"].map((n) => ({ name: n, path: `/${n}` }));
    expect(typeAheadMatch(names, "ba")).toBe("/Banana");
    expect(typeAheadMatch(names, "bz")).toBe("/cherry");
    expect(typeAheadMatch(names, "zz")).toBeNull();
  });
});

describe("format", () => {
  it("labels kinds", () => {
    expect(kindLabel(entry("x", { kind: "dir", extension: null }))).toBe("Folder");
    expect(kindLabel(entry("Safari.app", { kind: "package" }))).toBe("Application");
    expect(kindLabel(entry("a.png"))).toBe("PNG image");
    expect(kindLabel(entry("a.xyz"))).toBe("XYZ file");
  });

  it("formats dates relative to today", () => {
    const now = new Date(2026, 9, 27, 15, 0).getTime();
    expect(formatDate(new Date(2026, 9, 27, 9, 5).getTime(), now)).toMatch(/^Today at /);
    expect(formatDate(new Date(2026, 9, 26, 23, 59).getTime(), now)).toMatch(/^Yesterday at /);
    expect(formatDate(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
    expect(formatDate(0, now)).toBe("--");
  });
});

describe("naturalKey", () => {
  it("orders like the collator", async () => {
    const { compareNames, naturalKey } = await import("@/lib/sort");
    const names = ["file10", "File2", "résumé", "Resume", "Çay", "cay2", "a_b", "a0b", "z", "007", "7", "ab"];
    const byKey = names.toSorted((a, b) =>
      naturalKey(a) < naturalKey(b) ? -1 : naturalKey(a) > naturalKey(b) ? 1 : 0,
    );
    const byCollator = names.toSorted(compareNames);
    // Equal-key names may differ in tie order; compare the keys' sequence.
    expect(byKey.map(naturalKey)).toEqual(byCollator.map(naturalKey));
  });
});

describe("icon urls", () => {
  it("shares one url per extension and uses paths for folders", () => {
    expect(iconUrl(entry("a.PDF"), 32)).toBe("oxthumb://localhost/ext/32/pdf");
    expect(iconUrl(entry("Music", { kind: "dir", extension: null, path: "/Users/me/Music" }), 32)).toBe(
      "oxthumb://localhost/path/32/%2FUsers%2Fme%2FMusic",
    );
    expect(thumbnailUrl(entry("p.jpg", { modifiedMs: 5, size: 9 }), 128)).toBe(
      "oxthumb://localhost/thumb/128/%2Fd%2Fp.jpg?v=5-9",
    );
    expect(thumbnailUrl(entry("notes.txt"), 128)).toBe("oxthumb://localhost/ext/128/txt");
  });
});

describe("applyDelta", () => {
  it("removes, replaces and appends by path", async () => {
    const { applyDelta } = await import("@/stores/dir-cache-store");
    const a = entry("a");
    const b = entry("b", { size: 1 });
    const next = applyDelta([a, b], {
      dir: "/d",
      removed: ["/d/a"],
      upserted: [entry("b", { size: 2 }), entry("c")],
      rescan: false,
    });
    expect(next.map((e) => [e.name, e.size])).toEqual([
      ["b", 2],
      ["c", 0],
    ]);
  });
});

describe("applyTags", () => {
  it("replaces only tagged entries", async () => {
    const { applyTags } = await import("@/stores/dir-cache-store");
    const a = entry("a");
    const b = entry("b");
    const next = applyTags([a, b], new Map([["/d/b", [{ name: "Red", color: 6 }]]]));
    expect(next[0]).toBe(a);
    expect(next[1]?.tags).toEqual([{ name: "Red", color: 6 }]);
  });
});

describe("formatDuration", () => {
  it("shows minutes, and hours only when needed", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(75.4)).toBe("1:15");
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});
