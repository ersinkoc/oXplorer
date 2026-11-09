// Quick Look follows the selection; items on a server or in an archive are
// copied first and the copies finish in any order: the panel always ends on
// the selected item (gated promises, no sleeps).
import { expect, it, vi } from "vitest";

const gates: Record<string, (real: string) => void> = {};
const shown: [string[], boolean][] = [];
let stateCb: ((e: { payload: { visible: boolean } }) => void) | null = null;
vi.mock("@/bindings", () => ({
  commands: {
    quickLook: async (paths: string[], _index: number, open: boolean) => {
      shown.push([paths, open]);
      return { status: "ok", data: null };
    },
    quickLookClose: async () => ({ status: "ok", data: null }),
  },
  events: {
    quickLookState: {
      listen: async (cb: typeof stateCb) => {
        stateCb = cb;
        return () => {};
      },
    },
    quickLookKey: { listen: async () => () => {} },
  },
}));
vi.mock("@/commands/archive-unlock", () => ({ unlockArchiveOf: async () => true }));
vi.mock("@/commands/locations", () => ({
  materialize: (p: string) =>
    new Promise<string>((resolve) => {
      gates[p] = resolve;
    }),
}));
const { installQuickLook, toggleQuickLook } = await import("@/features/preview/quick-look");
const { setPaneLayout } = await import("@/features/file-view/visible-order");
const { useWorkspace, initialPane } = await import("@/stores/workspace-store");

const [A, B, C, D] = ["remote:c/a.mov", "remote:c/b.mov", "remote:c/c.txt", "remote:c/d.txt"];
const select = (p: string) =>
  useWorkspace.getState().setSelection({ paths: new Set([p]), anchor: p, focus: p });
const flush = () => new Promise((r) => setTimeout(r, 0));
const real = (p: string) => `/tmp/${p.split("/").pop()}`;

it("the panel follows the selection, whatever order copies finish in", async () => {
  useWorkspace.setState({
    panes: { left: initialPane("remote:c/"), right: initialPane("/R") },
    activePane: "left",
  });
  setPaneLayout("left", { order: [A, B, C, D], columns: 1 });
  installQuickLook();
  // Opening: the selection moves to B while A is still being copied.
  select(A);
  toggleQuickLook();
  await flush();
  select(B);
  gates[A]?.(real(A));
  await flush();
  expect(shown).toEqual([]);
  gates[B]?.(real(B));
  await flush();
  expect(shown).toEqual([[[real(B)], true]]);
  stateCb?.({ payload: { visible: true } });

  // In order.
  select(D);
  await flush();
  gates[D]?.(real(D));
  await flush();
  expect(shown.at(-1)).toEqual([[real(D)], false]);

  // Out of order: B (slow) then C (fast).
  select(B);
  select(C);
  await flush();
  gates[C]?.(real(C));
  await flush();
  gates[B]?.(real(B));
  await flush();
  expect(shown.at(-1)).toEqual([[real(C)], false]);

  // Three quick moves, finishing last-first.
  const before = shown.length;
  select(A);
  select(B);
  select(D);
  await flush();
  gates[D]?.(real(D));
  gates[B]?.(real(B));
  gates[A]?.(real(A));
  await flush();
  expect(shown.slice(before)).toEqual([[[real(D)], false]]);
});
