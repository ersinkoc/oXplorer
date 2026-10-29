import { describe, expect, it } from "vitest";
import { dropMode, isValidDrop, localFolders, volumeOf } from "@/features/dnd/drop-target";
import type { FileEntry } from "@/lib/ipc";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";

describe("drop rules", () => {
  useApp.setState({
    volumes: [
      {
        name: "Macintosh HD",
        mountPoint: "/",
        isRoot: true,
        isLocal: true,
        isReadOnly: false,
        fileSystem: "apfs",
        totalBytes: 1,
        availableBytes: 1,
      },
      {
        name: "USB",
        mountPoint: "/Volumes/USB",
        isRoot: false,
        isLocal: true,
        isReadOnly: false,
        fileSystem: "exfat",
        totalBytes: 1,
        availableBytes: 1,
      },
    ],
  });

  it("finds the volume by longest mount prefix", () => {
    expect(volumeOf("/Users/me/a")).toBe("/");
    expect(volumeOf("/Volumes/USB/x")).toBe("/Volumes/USB");
    expect(volumeOf("/Volumes/USB2/x")).toBe("/");
  });

  it("moves within a volume, copies across, ⌥ forces copy", () => {
    expect(dropMode(["/Users/me/a"], "/Users/me/dest", false)).toBe("move");
    expect(dropMode(["/Users/me/a"], "/Volumes/USB", false)).toBe("copy");
    expect(dropMode(["/Users/me/a"], "/Users/me/dest", true)).toBe("copy");
  });

  it("rejects drops into self, descendants, or the current parent", () => {
    expect(isValidDrop(["/a/b"], "/a/b")).toBe(false);
    expect(isValidDrop(["/a/b"], "/a/b/c")).toBe(false);
    expect(isValidDrop(["/a/b", "/a/c"], "/a")).toBe(false);
    expect(isValidDrop(["/a/b"], "/a/bb")).toBe(true);
    expect(isValidDrop(["/a/b", "/x/c"], "/a")).toBe(true);
  });
});

describe("favorites drop", () => {
  it("takes only folders on this Mac", () => {
    const entry = (name: string, kind: FileEntry["kind"]) =>
      ({ name, path: `/d/${name}`, kind }) as FileEntry;
    useDirCache.setState({
      dirs: {
        "/d": {
          status: "ready",
          error: null,
          entries: [entry("Photos", "dir"), entry("a.txt", "file"), entry("Tool.app", "package")],
        },
      },
    });
    expect(localFolders(["/d/Photos", "/d/a.txt", "/d/Tool.app", "/d/unknown", "remote:x/y"])).toEqual([
      "/d/Photos",
    ]);
  });
});
