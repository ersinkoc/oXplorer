// @vitest-environment happy-dom
// A stored password only goes to the server it was typed for: editing the
// host, user or kind without typing it again forgets it.
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

const calls: [string, string][] = [];
vi.mock("@/bindings", () => ({
  commands: {
    remoteHasSecret: async () => true,
    remoteSaveSecret: async (id: string, s: string) => {
      calls.push([id, s]);
      return { status: "ok", data: null };
    },
    remoteTest: async () => ({ status: "ok", data: null }),
  },
}));
const { ConnectionsSection } = await import("@/features/settings/connections-section");

const saved = {
  id: "c1",
  name: "Files",
  kind: "ftp" as const,
  host: "ftps://files.example.com",
  user: "me",
  root: "",
  bucket: "",
  region: "",
};

/** FTP inputs: 0 name, 1 host, 2 user, 3 password, 4 folder. Edits one input (by index) and/or the kind, optionally types a password, saves. */
async function save(opts: { field?: [number, string]; kind?: string; password?: string; fresh?: boolean }) {
  calls.length = 0;
  let list = opts.fresh ? [] : [saved];
  const prefs = (() => [list, (v: typeof list) => (list = v)]) as never;
  const view = render(createElement(ConnectionsSection, { usePref: prefs }));
  fireEvent.click(view.getByText(opts.fresh ? "Add Connection" : "Files"));
  const form = view.container.querySelector("form") as Element;
  const inputs = form.querySelectorAll("input");
  if (opts.fresh) fireEvent.change(inputs[1] as Element, { target: { value: "new.example.com" } });
  if (opts.field) fireEvent.change(inputs[opts.field[0]] as Element, { target: { value: opts.field[1] } });
  if (opts.kind) fireEvent.change(form.querySelector("select") as Element, { target: { value: opts.kind } });
  if (opts.password !== undefined) {
    const pw = form.querySelector('input[type="password"]') as Element;
    fireEvent.change(pw, { target: { value: opts.password } });
  }
  await act(async () => fireEvent.submit(form));
  cleanup();
  return { calls: JSON.stringify(calls), list };
}

afterEach(cleanup);

it("keeps the stored password with its server only", async () => {
  expect((await save({ field: [1, "files.example.com"] })).calls).toBe('[["c1",""]]');
  expect((await save({ field: [2, "admin"] })).calls).toBe('[["c1",""]]');
  expect((await save({ kind: "sftp" })).calls).toBe('[["c1",""]]');
  expect((await save({ field: [1, "other.example.com"], password: "pw2" })).calls).toBe('[["c1","pw2"]]');
  expect((await save({ field: [0, "Renamed"] })).calls).toBe("[]");
  expect((await save({ field: [4, "/srv"] })).calls).toBe("[]");
  const fresh = await save({ fresh: true });
  expect(fresh.calls).toBe("[]");
  expect(fresh.list).toHaveLength(1);
});
