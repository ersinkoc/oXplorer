import { expect, it, vi } from "vitest";

const channels: { onmessage: (m: unknown) => void }[] = [];
const resolvers: ((v: unknown) => void)[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-log", () => ({ debug: async () => {} }));
vi.mock("@/bindings", () => ({
  commands: {
    openDir: (_path: string, channel: { onmessage: (m: unknown) => void }) => {
      channels.push(channel);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  },
}));

const { SPARE, useDirCache } = await import("@/stores/dir-cache-store");

const entry = (dir: string, name: string) => ({ path: `${dir}/${name}`, name, kind: "file" }) as never;
const settle = () => new Promise((r) => setTimeout(r, 0));
const names = (dir: string) => useDirCache.getState().dirs[dir]?.entries.map((e) => e.name);

it("keeps a change that lands while the folder reloads", async () => {
  void useDirCache.getState().load("/d");
  channels[0]?.onmessage({ type: "batch", entries: [entry("/d", "a")] });
  channels[0]?.onmessage({ type: "done" });
  await settle();
  expect(names("/d")).toEqual(["a"]);

  // ⌘R or a watcher rescan; the folder was read before b appeared.
  void useDirCache.getState().load("/d");
  channels[1]?.onmessage({ type: "batch", entries: [entry("/d", "a")] });
  useDirCache.getState().applyChange({ dir: "/d", upserted: [entry("/d", "b")], removed: [], rescan: false });
  expect(names("/d")).toEqual(["a", "b"]);
  channels[1]?.onmessage({ type: "done" });
  await settle();
  expect(names("/d")).toEqual(["a", "b"]);
});

it("drops the changes queued for a listing that failed", async () => {
  const base = channels.length;
  void useDirCache.getState().load("/e");
  useDirCache.getState().applyChange({ dir: "/e", upserted: [], removed: ["/e/x"], rescan: false });
  resolvers[base]?.({ status: "error", error: { kind: "io", path: null, message: "boom" } });
  await settle();
  expect(useDirCache.getState().dirs["/e"]?.status).toBe("error");

  void useDirCache.getState().load("/e");
  channels[base + 1]?.onmessage({ type: "batch", entries: [entry("/e", "x")] });
  channels[base + 1]?.onmessage({ type: "done" });
  await settle();
  expect(names("/e")).toEqual(["x"]);
});

it("forgets listings no tab needs, keeping the most recent ones and running loads", async () => {
  const list = async (dir: string) => {
    const at = channels.length;
    void useDirCache.getState().load(dir);
    channels[at]?.onmessage({ type: "batch", entries: [entry(dir, "f")] });
    channels[at]?.onmessage({ type: "done" });
    await settle();
  };
  await list("/kept");
  for (let i = 0; i < SPARE + 5; i++) await list(`/old/${i}`);
  void useDirCache.getState().load("/running");

  useDirCache.getState().prune(new Set(["/kept"]));
  const dirs = useDirCache.getState().dirs;
  expect(dirs["/kept"]).toBeDefined();
  expect(dirs["/running"]?.status).toBe("loading");
  // The oldest go: "/d", "/e" and the first few of "/old".
  expect(dirs["/d"]).toBeUndefined();
  expect(dirs["/old/0"]).toBeUndefined();
  expect(dirs[`/old/${SPARE + 4}`]).toBeDefined();
  expect(Object.keys(dirs)).toHaveLength(SPARE + 1);
});
