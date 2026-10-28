import { describe, expect, it } from "vitest";
import { parseRemotePath, remoteDirOf, remoteParent, remotePath } from "@/lib/remote-path";

describe("remote paths", () => {
  it("round-trips and walks up", () => {
    const p = remotePath("c1", "a/b c");
    expect(parseRemotePath(p)).toEqual({ id: "c1", inner: "a/b c" });
    expect(parseRemotePath(remotePath("c1"))).toEqual({ id: "c1", inner: "" });
    expect(remoteParent(p)).toEqual({ path: remotePath("c1", "a"), select: p });
    expect(remoteParent(remotePath("c1", "a"))?.path).toBe(remotePath("c1", ""));
    expect(remoteParent(remotePath("c1"))).toBeNull();
    expect(remoteDirOf(remotePath("c1", "a/f.txt"))).toBe(remotePath("c1", "a"));
    expect(parseRemotePath("/local")).toBeNull();
  });
});
