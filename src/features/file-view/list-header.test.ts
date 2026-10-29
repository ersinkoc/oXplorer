import { describe, expect, it } from "vitest";
import { gridTemplate, visibleColumns } from "@/features/file-view/list-header";

describe("list columns", () => {
  it("keeps display order, drops unknown names and keeps Where for search results", () => {
    expect(visibleColumns(["kind", "created", "bogus"])).toEqual(["created", "kind"]);
    expect(visibleColumns([])).toEqual([]);
    expect(visibleColumns(["size"], true)).toEqual(["size", "kind"]);
  });

  it("sizes the grid, with a default for widths saved before a column existed", () => {
    const widths = { modified: 190, size: 90, kind: 150 };
    expect(gridTemplate(widths, ["created", "size"])).toBe("minmax(180px, 1fr) 150px 90px");
  });
});
