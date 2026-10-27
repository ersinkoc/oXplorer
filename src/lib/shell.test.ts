import { describe, expect, it } from "vitest";
import { parseOsc7, shellArgs, shellQuote } from "@/lib/shell";

describe("shell helpers", () => {
  it("quotes only when needed", () => {
    expect(shellQuote("/Users/me/file.txt")).toBe("/Users/me/file.txt");
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
    expect(shellQuote("/x/$HOME;rm")).toBe("'/x/$HOME;rm'");
    expect(shellArgs(["/a", "/b c"])).toBe("/a '/b c' ");
  });

  it("parses local OSC 7 reports", () => {
    expect(parseOsc7("file://Mac.local/Users/me/dir%20x", ["Mac.local"])).toBe("/Users/me/dir x");
    expect(parseOsc7("file:///tmp")).toBe("/tmp");
    expect(parseOsc7("file://localhost/%C3%A7%25")).toBe("/ç%");
    expect(parseOsc7("file://server/etc", ["Mac.local"])).toBeNull();
    expect(parseOsc7("http://x/y")).toBeNull();
    expect(parseOsc7("file:///bad%E0%A4")).toBeNull();
  });
});
