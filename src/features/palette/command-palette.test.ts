// View ▸ "as List" / "as Icons" / "as Columns" only read right under their menu;
// the palette shows them as "View as …" and still finds them by the menu title.
import { expect, it, vi } from "vitest";

vi.mock("@/bindings", () => ({ commands: {}, events: {} }));
vi.mock("@/commands/navigation", () => ({ goToTypedPath: async () => true, navigateTo: () => {} }));

it("palette titles of view modes read on their own", async () => {
  const { defineCommands } = await import("@/commands/registry");
  const { allItems } = await import("@/features/palette/command-palette");
  defineCommands([
    { id: "view.asList", title: "as List", run: () => {} },
    { id: "view.asIcons", title: "as Icons", run: () => {} },
    { id: "view.asColumns", title: "as Columns", run: () => {} },
    { id: "view.sortName", title: "Sort by Name", run: () => {} },
  ]);
  const item = (id: string) => allItems().find((i) => i.key === `cmd:${id}`);
  expect(
    ["view.asList", "view.asIcons", "view.asColumns", "view.sortName"].map((id) => item(id)?.title),
  ).toEqual(["View as List", "View as Icons", "View as Columns", "Sort by Name"]);
  expect(item("view.asList")?.match).toBe("View as List as List");
  // Other commands match on their title alone.
  expect(item("view.sortName")?.match).toBe("Sort by Name");
});
