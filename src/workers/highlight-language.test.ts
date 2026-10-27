import { describe, expect, it } from "vitest";
import { languageFor } from "@/workers/highlight-language";

const KNOWN = new Set([
  "typescript",
  "ts",
  "tsx",
  "rs",
  "xml",
  "c",
  "dockerfile",
  "ignore",
  "json",
  "toml",
  "md",
]);

describe("languageFor", () => {
  it("maps extensions, aliases and well-known file names", () => {
    expect(languageFor("app.ts", KNOWN)).toBe("ts");
    expect(languageFor("Main.RS", KNOWN)).toBe("rs");
    expect(languageFor("Info.plist", KNOWN)).toBe("xml");
    expect(languageFor("util.h", KNOWN)).toBe("c");
    expect(languageFor("Dockerfile", KNOWN)).toBe("dockerfile");
    expect(languageFor(".gitignore", KNOWN)).toBe("ignore");
    expect(languageFor("Cargo.lock", KNOWN)).toBe("toml");
  });

  it("leaves unknown or extensionless files plain", () => {
    expect(languageFor("notes", KNOWN)).toBeNull();
    expect(languageFor("data.xyz", KNOWN)).toBeNull();
  });
});
