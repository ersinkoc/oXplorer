import { describe, expect, it } from "vitest";
import { checksumListName, isChecksumList } from "./checksum-list";

describe("isChecksumList", () => {
  it("knows the usual names", () => {
    for (const n of [
      "ubuntu.iso.sha256",
      "x.MD5",
      "SHA256SUMS",
      "sha512sums.txt",
      "checksums.txt",
      "a.sha1sum",
    ])
      expect(isChecksumList(n)).toBe(true);
    for (const n of ["notes.txt", "sha256.c", "md5", "SUMS"]) expect(isChecksumList(n)).toBe(false);
  });
});

describe("checksumListName", () => {
  it("names one file's list after it, several after the algorithm", () => {
    expect(checksumListName("sha256", ["x.iso"])).toBe("x.iso.sha256");
    expect(checksumListName("md5", ["a", "b"])).toBe("MD5SUMS");
    // and the list it makes is recognised
    expect(isChecksumList(checksumListName("sha512", ["a", "b"]))).toBe(true);
    expect(isChecksumList(checksumListName("sha1", ["a"]))).toBe(true);
  });
});
