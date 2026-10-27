import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = vi.fn();
    set = vi.fn(async () => {});
  },
}));

const { fromSession, recallScroll, rememberScroll, toSession } = await import("@/stores/session");
const { newTab, useWorkspace } = await import("@/stores/workspace-store");

describe("session", () => {
  it("round-trips tabs, layout and scroll offsets", () => {
    const a = newTab("/a", { history: { stack: ["/", "/a"], index: 1 } });
    const b = newTab("/b", { pinned: true });
    const r = newTab("/r");
    a.view.mode = "icons";
    a.view.sort = { field: "size", direction: "desc", foldersFirst: false };
    a.view.filter = "not kept";
    useWorkspace.setState({
      panes: { left: { tabs: [b, a], activeTabId: a.id }, right: { tabs: [r], activeTabId: r.id } },
      activePane: "right",
      dualPane: true,
      split: 0.3,
      preview: { visible: true, width: 400 },
    });
    rememberScroll(a.id, "/a", 480);

    const saved = JSON.parse(JSON.stringify(toSession(useWorkspace.getState())));
    const restored = fromSession(saved, "/home");
    const left = restored.panes.left;
    expect(left.tabs.map((t) => t.path)).toEqual(["/b", "/a"]);
    expect(left.activeTabId).toBe(a.id);
    expect(left.tabs[0]?.pinned).toBe(true);
    expect(left.tabs[1]?.view).toEqual({ mode: "icons", sort: a.view.sort, filter: "" });
    expect(left.tabs[1]?.history).toEqual({ stack: ["/", "/a"], index: 1 });
    expect(restored).toMatchObject({
      activePane: "right",
      dualPane: true,
      split: 0.3,
      preview: { visible: true, width: 400 },
    });
    expect(recallScroll(a.id, "/a")).toBe(480);
  });

  it("falls back to the home folder for missing or broken data", () => {
    for (const raw of [
      undefined,
      null,
      42,
      { version: 9 },
      { version: 1, panes: { left: { tabs: [{ path: 3 }] } } },
    ]) {
      const s = fromSession(raw, "/home");
      expect(s.panes.left.tabs.map((t) => t.path)).toEqual(["/home"]);
      expect(s.panes.right.tabs.map((t) => t.path)).toEqual(["/home"]);
      expect(s.dualPane).toBe(false);
      expect(s.activePane).toBe("left");
    }
  });

  it("repairs a history that doesn't contain the current folder", () => {
    const s = fromSession(
      {
        version: 1,
        panes: { left: { active: 0, tabs: [{ path: "/x", history: { stack: ["/y"], index: 0 } }] } },
      },
      "/home",
    );
    expect(s.panes.left.tabs[0]?.history).toEqual({ stack: ["/x"], index: 0 });
  });
});
