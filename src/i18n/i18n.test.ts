import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLanguage, translate } from "@/i18n";
import { tr } from "@/i18n/tr";

const ROOT = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== "bindings.ts" ? [p] : [];
  });
}

/** String literals passed to t() / tn() anywhere in src. */
function usedKeys(): Set<string> {
  const keys = new Set<string>();
  const literal = String.raw`"((?:[^"\\]|\\.)*)"`;
  const tCall = new RegExp(String.raw`\b(?:t|msg)\(\s*${literal}`, "g");
  // Command titles are translated where they're shown (palette, menus).
  const title = new RegExp(String.raw`\btitle:\s*${literal}`, "g");
  const tnCall = new RegExp(String.raw`\btn\(\s*[^,]+,\s*${literal},\s*${literal}`, "g");
  for (const file of sources(ROOT)) {
    const code = readFileSync(file, "utf8");
    for (const m of code.matchAll(tCall)) keys.add(JSON.parse(`"${m[1]}"`));
    if (file.includes("/commands/")) for (const m of code.matchAll(title)) keys.add(JSON.parse(`"${m[1]}"`));
    for (const m of code.matchAll(tnCall)) {
      keys.add(JSON.parse(`"${m[1]}"`));
      keys.add(JSON.parse(`"${m[2]}"`));
    }
  }
  return keys;
}

/** Native menu titles live in Rust; the frontend sends their translations. */
function menuTitles(): Set<string> {
  const code = readFileSync(join(ROOT, "../src-tauri/src/menu.rs"), "utf8");
  return new Set([...code.matchAll(/\("[a-zA-Z.0-9]+", "([^"]+)", (?:Some|None)/g)].map((m) => m[1] ?? ""));
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n", () => {
  const used = new Set([...usedKeys(), ...menuTitles()]);

  it("has a Turkish translation for every UI string", () => {
    const missing = [...used].filter((k) => !(k in tr));
    expect(missing).toEqual([]);
  });

  it("has no unused Turkish entries", () => {
    const unused = Object.keys(tr).filter((k) => !used.has(k));
    expect(unused).toEqual([]);
  });

  it("keeps the same placeholders in translations", () => {
    const broken = Object.entries(tr).filter(([en, t]) => placeholders(en).join() !== placeholders(t).join());
    expect(broken).toEqual([]);
  });

  it("translates with placeholders and falls back to English", () => {
    expect(translate("en", "{count} files", { count: 3 })).toBe("3 files");
    expect(translate("tr", "not a key {x}", { x: 1 })).toBe("not a key 1");
    expect(resolveLanguage("system", "tr-TR")).toBe("tr");
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("en", "tr-TR")).toBe("en");
  });
});
