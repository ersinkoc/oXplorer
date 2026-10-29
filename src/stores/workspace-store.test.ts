import { beforeEach, describe, expect, it } from "vitest";
import { getActiveTab, newTab, useWorkspace } from "@/stores/workspace-store";

describe("workspace history", () => {
  beforeEach(() => {
    const tab = newTab("/a");
    useWorkspace.setState({
      panes: { left: { tabs: [tab], activeTabId: tab.id }, right: { tabs: [newTab("/")], activeTabId: "" } },
      activePane: "left",
    });
  });

  it("pushes, goes back/forward and truncates forward history on push", () => {
    const { setPath } = useWorkspace.getState();
    setPath("/a/b");
    setPath("/a/b/c");
    expect(getActiveTab().history).toEqual({ stack: ["/a", "/a/b", "/a/b/c"], index: 2 });

    setPath("/a/b", { history: "back" });
    setPath("/a", { history: "back" });
    expect(getActiveTab().history.index).toBe(0);
    setPath("/a/b", { history: "forward" });
    expect(getActiveTab().path).toBe("/a/b");

    setPath("/x");
    expect(getActiveTab().history).toEqual({ stack: ["/a", "/a/b", "/x"], index: 2 });
  });

  it("does not duplicate the current entry and applies `select`", () => {
    const { setPath } = useWorkspace.getState();
    setPath("/a");
    expect(getActiveTab().history.stack).toEqual(["/a"]);
    setPath("/", { select: "/a" });
    expect([...getActiveTab().selection.paths]).toEqual(["/a"]);
  });
});

describe("tabs and panes", () => {
  const ws = () => useWorkspace.getState();
  const paths = (pane: "left" | "right") => ws().panes[pane].tabs.map((t) => t.path);

  beforeEach(() => {
    const left = newTab("/a");
    const right = newTab("/r");
    useWorkspace.setState({
      panes: {
        left: { tabs: [left], activeTabId: left.id },
        right: { tabs: [right], activeTabId: right.id },
      },
      activePane: "left",
      dualPane: false,
    });
  });

  it("opens, cycles and closes tabs, activating the right neighbor", () => {
    ws().openTab("/b");
    ws().openTab("/c");
    expect(paths("left")).toEqual(["/a", "/b", "/c"]);
    expect(getActiveTab().path).toBe("/c");
    ws().cycleTab(1);
    expect(getActiveTab().path).toBe("/a");
    ws().cycleTab(-1);
    expect(getActiveTab().path).toBe("/c");

    const b = ws().panes.left.tabs[1];
    ws().activateTab("left", b?.id ?? "");
    expect(ws().closeTab("left", b?.id ?? "")).toBe(true);
    expect(getActiveTab().path).toBe("/c");
    expect(ws().closeTab("left", getActiveTab().id)).toBe(true);
    expect(getActiveTab().path).toBe("/a");
    // The last tab is never removed by the store.
    expect(ws().closeTab("left", getActiveTab().id)).toBe(false);
  });

  it("reopens closed tabs in place, newest first, with their history", () => {
    ws().setPath("/a/x");
    ws().openTab("/b");
    ws().openTab("/c");
    const first = ws().panes.left.tabs[0]?.id ?? "";
    ws().closeTab("left", first);
    ws().closeTab("left", getActiveTab().id);
    expect(paths("left")).toEqual(["/b"]);
    expect(ws().reopenClosedTab()).toBe(true);
    expect(paths("left")).toEqual(["/b", "/c"]);
    expect(ws().reopenClosedTab()).toBe(true);
    expect(paths("left")).toEqual(["/a/x", "/b", "/c"]);
    expect(getActiveTab().history.stack).toEqual(["/a", "/a/x"]);
  });

  it("reopens tabs closed together in their order, after pinned tabs", () => {
    ws().setPath("/a");
    ws().openTab("/b");
    ws().openTab("/c");
    ws().openTab("/d");
    const a = ws().panes.left.tabs[0]?.id ?? "";
    ws().closeOtherTabs("left", a);
    for (let i = 0; i < 3; i++) ws().reopenClosedTab();
    expect(paths("left")).toEqual(["/a", "/b", "/c", "/d"]);

    // A tab closed at the front comes back after tabs pinned since.
    ws().closeTab("left", a);
    ws().togglePin("left", ws().panes.left.tabs[0]?.id ?? "");
    ws().reopenClosedTab();
    expect(paths("left")).toEqual(["/b", "/a", "/c", "/d"]);
    expect(ws().panes.left.tabs.map((t) => t.pinned)).toEqual([true, false, false, false]);
  });

  it("keeps pinned tabs first and spares them when closing others", () => {
    ws().openTab("/b");
    ws().openTab("/c");
    const c = getActiveTab().id;
    ws().togglePin("left", c);
    expect(paths("left")).toEqual(["/c", "/a", "/b"]);
    // Unpinned tabs can't be dragged in front of pinned ones.
    const b = ws().panes.left.tabs[2]?.id ?? "";
    ws().moveTab("left", b, "left", 0);
    expect(paths("left")).toEqual(["/c", "/b", "/a"]);

    ws().closeOtherTabs("left", b);
    expect(paths("left")).toEqual(["/c", "/b"]);
    ws().closeTabsToRight("left", c);
    expect(paths("left")).toEqual(["/c"]);
  });

  it("moves tabs between panes without leaving a pane empty", () => {
    const a = getActiveTab().id;
    ws().moveTab("left", a, "right", 0);
    expect(ws().dualPane).toBe(true);
    expect(ws().activePane).toBe("right");
    expect(paths("right")).toEqual(["/a", "/r"]);
    expect(paths("left")).toEqual(["/a"]);
    expect(ws().panes.left.tabs[0]?.id).not.toBe(a);
  });

  it("swaps panes and falls back to the left pane when dual mode ends", () => {
    ws().setDualPane(true);
    ws().setActivePane("right");
    ws().swapPanes();
    expect(paths("left")).toEqual(["/r"]);
    expect(ws().activePane).toBe("left");
    ws().setActivePane("right");
    ws().setDualPane(false);
    expect(ws().activePane).toBe("left");
    ws().setActivePane("right");
    expect(ws().activePane).toBe("left");
  });
});
