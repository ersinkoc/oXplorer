// Watch/unwatch calls for one folder go out one after another (each runs on its
// own Rust thread: an unwatch landing first would leave the folder watched);
// other folders aren't held up, and a failed watch doesn't block the next call.
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const log: string[] = [];
const held: Record<string, (ok: boolean) => void> = {};
vi.mock("@tauri-apps/plugin-log", () => ({ debug: async () => {} }));
vi.mock("@/stores/git-store", () => ({ refreshAllGit: vi.fn(), refreshGit: vi.fn() }));
vi.mock("@/bindings", () => ({
  commands: {
    listVolumes: async () => ({ status: "ok", data: [] }),
    watchDir: (p: string) => {
      log.push(`watch ${p}`);
      if (p === "/Volumes") return Promise.resolve({ status: "ok", data: null });
      return new Promise((resolve) => {
        held[p] = (ok) => {
          log.push(`watch ${p} ${ok ? "done" : "failed"}`);
          resolve(ok ? { status: "ok", data: null } : { status: "error", error: { kind: "io" } });
        };
      });
    },
    unwatchDir: async (p: string) => {
      log.push(`unwatch ${p}`);
      return { status: "ok", data: null };
    },
  },
  events: { dirChanged: { listen: async () => () => {} } },
}));
const { useLiveDirs } = await import("@/features/watch/use-live-dirs");
const { initialPane, useWorkspace } = await import("@/stores/workspace-store");

const show = (path: string) =>
  act(() =>
    useWorkspace.setState({ panes: { left: initialPane(path), right: initialPane("/R") }, dualPane: false }),
  );
const settle = () => act(async () => await new Promise((r) => setTimeout(r, 0)));
const ofPath = (p: string) => log.filter((l) => l.endsWith(` ${p}`) || l.includes(` ${p} `));

it("keeps each path's calls in order without holding up other paths", async () => {
  show("/P");
  renderHook(() => useLiveDirs());
  await settle();
  show("/Q");
  await settle();
  // /Q is watched at once although /P's watch still runs.
  expect(log).toContain("watch /Q");
  show("/P");
  await settle();
  held["/P"]?.(true);
  await settle();
  // P → Q → P: watch, unwatch, watch, one after another.
  expect(ofPath("/P")).toEqual(["watch /P", "watch /P done", "unwatch /P", "watch /P"]);
  held["/P"]?.(true);
  await settle();

  // A failed watch: the unwatch after it still goes out.
  show("/F");
  await settle();
  show("/G");
  await settle();
  held["/F"]?.(false);
  await settle();
  expect(ofPath("/F")).toEqual(["watch /F", "watch /F failed", "unwatch /F"]);
});
