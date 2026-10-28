import { describe, expect, it } from "vitest";
import {
  archiveParent,
  archivePath,
  archiveTitle,
  isArchiveName,
  parseArchivePath,
} from "@/lib/archive-path";

describe("archive paths", () => {
  const zip = "/Users/me/a b.zip";

  it("round-trips archive locations", () => {
    expect(parseArchivePath(archivePath(zip, "docs/img"))).toEqual({ archive: zip, inner: "docs/img" });
    expect(parseArchivePath(archivePath(zip))).toEqual({ archive: zip, inner: "" });
    expect(parseArchivePath("/plain")).toBeNull();
  });

  it("goes up inside the archive, then to its folder", () => {
    expect(archiveParent(archivePath(zip, "docs/img"))).toEqual({
      path: archivePath(zip, "docs"),
      select: archivePath(zip, "docs/img"),
    });
    expect(archiveParent(archivePath(zip, "docs"))?.path).toBe(archivePath(zip, ""));
    expect(archiveParent(archivePath(zip, ""))).toEqual({ path: "/Users/me", select: zip });
  });

  it("recognizes archives and titles them", () => {
    expect(isArchiveName("x.tar.gz")).toBe(true);
    expect(isArchiveName("x.ZIP")).toBe(true);
    expect(isArchiveName(".zip")).toBe(false);
    expect(isArchiveName("x.gz")).toBe(false);
    expect(archiveTitle(archivePath(zip))).toBe("a b.zip");
    expect(archiveTitle(archivePath(zip, "docs/img"))).toBe("img");
  });
});
