import { describe, expect, it } from "vitest";
import { LANGUAGES, languageFor } from "@/workers/highlight-language";

describe("languageFor", () => {
  it("maps extensions, aliases and well-known file names", () => {
    expect(languageFor("app.ts")).toBe("typescript");
    expect(languageFor("Main.RS")).toBe("rust");
    expect(languageFor("Info.plist")).toBe("xml");
    expect(languageFor("util.h")).toBe("c");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("Cargo.lock")).toBe("toml");
    expect(languageFor("script.zsh")).toBe("shellscript");
    expect(languageFor("main.go")).toBe("go");
  });

  it("leaves unknown, unbundled or extensionless files plain", () => {
    expect(languageFor("notes")).toBeNull();
    expect(languageFor("data.xyz")).toBeNull();
    expect(languageFor(".gitignore")).toBeNull();
    expect(languageFor("prog.cobol")).toBeNull();
  });

  it("only maps to bundled languages", () => {
    const bundled = new Set<string>(LANGUAGES);
    for (const f of ["a.ts", "a.py", "a.m", "a.mm", "a.patch", "a.env", "a.conf", "Gemfile", ".zshrc"]) {
      const lang = languageFor(f);
      if (lang) expect(bundled.has(lang)).toBe(true);
    }
  });
});
