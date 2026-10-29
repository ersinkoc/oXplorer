import { describe, expect, it } from "vitest";
import { canSplit, firstPart, partCount } from "./split-parts";

describe("split parts", () => {
  it("finds the first part of a set", () => {
    expect(firstPart("/a/movie.mkv.001")).toBe("/a/movie.mkv.001");
    expect(firstPart("/a/movie.mkv.017")).toBe("/a/movie.mkv.001");
    expect(firstPart("/a/movie.mkv")).toBeNull();
    expect(firstPart("/a/.001")).toBeNull();
    expect(firstPart("/a/x.000")).toBeNull();
    expect(firstPart("/a/x.1234")).toBeNull();
  });

  it("counts parts and refuses pointless splits", () => {
    expect(partCount(250, 100)).toBe(3);
    expect(canSplit(100, 100)).toBe(false);
    expect(canSplit(101, 100)).toBe(true);
    expect(canSplit(1000, 1)).toBe(false);
    expect(canSplit(10, 0)).toBe(false);
  });
});
