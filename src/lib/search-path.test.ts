import { describe, expect, it } from "vitest";
import type { SearchSpec } from "@/bindings";
import { isSearchPath, parseSearchPath, realFolder, searchPath, searchTitle } from "@/lib/search-path";

const spec: SearchSpec = {
  scope: "/Users/me/a b",
  query: "report & co?",
  mode: "content",
  caseSensitive: true,
  regex: false,
  includeHidden: true,
};

describe("search paths", () => {
  it("round-trips a search through its virtual path", () => {
    const path = searchPath(spec);
    expect(isSearchPath(path)).toBe(true);
    expect(parseSearchPath(path)).toEqual(spec);
    expect(realFolder(path)).toBe("/Users/me/a b");
    expect(realFolder("/x")).toBe("/x");
  });

  it("rejects malformed or relative searches", () => {
    expect(parseSearchPath("/Users/me")).toBeNull();
    expect(parseSearchPath("search:?q=x&mode=name&in=relative")).toBeNull();
    expect(parseSearchPath("search:?q=x&mode=bogus&in=%2F")).toBeNull();
  });

  it("titles searches for tabs", () => {
    expect(searchTitle(spec)).toBe("“report & co?” in a b");
    expect(searchTitle({ ...spec, scope: "/", query: "" })).toBe("Search in Mac");
    expect(searchTitle({ ...spec, mode: "tag", query: "Red" })).toBe("Red");
  });
});
