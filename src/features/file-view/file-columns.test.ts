import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/preview/preview-pane", () => ({ EntryPreview: () => null }));
vi.mock("@/features/file-view/context-menu", () => ({ showItemMenu: vi.fn() }));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({ startDrag: vi.fn() }));
vi.mock("@tauri-apps/plugin-store", () => ({ LazyStore: class {} }));

const { ancestorChain, columnRoot } = await import("@/features/file-view/file-columns");

describe("column view geometry", () => {
  it("roots columns at home, a mounted volume, or the disk root", () => {
    const vols = ["/", "/Volumes/USB", "/Volumes/USB 2"];
    expect(columnRoot("/Users/me/a/b", "/Users/me", vols)).toBe("/Users/me");
    expect(columnRoot("/Users/me", "/Users/me", vols)).toBe("/Users/me");
    expect(columnRoot("/Users/mex", "/Users/me", vols)).toBe("/");
    expect(columnRoot("/Volumes/USB 2/x", "/Users/me", vols)).toBe("/Volumes/USB 2");
    expect(columnRoot("/Applications", "/Users/me", vols)).toBe("/");
  });

  it("lists ancestors from the root down to the parent", () => {
    expect(ancestorChain("/Users/me", "/Users/me/a/b")).toEqual(["/Users/me", "/Users/me/a"]);
    expect(ancestorChain("/Users/me", "/Users/me")).toEqual([]);
    expect(ancestorChain("/", "/a/b")).toEqual(["/", "/a"]);
    expect(ancestorChain("/", "/")).toEqual([]);
  });
});
