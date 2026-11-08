import { msg } from "@/i18n";
import { parent } from "@/lib/path";

/**
 * A name in a folder, case-insensitive like the default APFS volume. Items
 * from several folders (search results) only clash within their own folder.
 */
export function siblingKey(dir: string, name: string): string {
  return `${dir}\n${name.toLowerCase()}`;
}

/** Finder's "Rename N Items" options. */
export type RenameRule =
  | { kind: "replace"; find: string; replace: string; regex: boolean; caseSensitive: boolean }
  | { kind: "add"; text: string; where: "before" | "after" }
  | { kind: "format"; base: string; start: number; digits: number; where: "before" | "after" };

export interface RenamePreview {
  path: string;
  name: string;
  newName: string;
  /** Why this name can't be used, if it can't (English; translated where shown). */
  problem: string | null;
}

/** "report.final.pdf" → ["report.final", ".pdf"]; folders and dotfiles have no extension. */
export function splitExtension(name: string, isFolder: boolean): [string, string] {
  if (isFolder) return [name, ""];
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles the find pattern. For an invalid regex it returns the engine's
 * reason (English, without the "Invalid regular expression: /…/: " prefix),
 * which the dialog shows inside a translated sentence.
 */
export function findPattern(rule: Extract<RenameRule, { kind: "replace" }>): RegExp | string {
  try {
    return new RegExp(rule.regex ? rule.find : escapeRegex(rule.find), rule.caseSensitive ? "gu" : "giu");
  } catch (e) {
    const reason =
      e instanceof Error ? e.message.replace(/^Invalid regular expression:\s*(\/.*\/\w*:\s*)?/i, "") : "";
    return reason.trim();
  }
}

function newName(
  name: string,
  isFolder: boolean,
  rule: RenameRule,
  index: number,
  pattern: RegExp | null,
): string {
  const [stem, ext] = splitExtension(name, isFolder);
  switch (rule.kind) {
    case "replace":
      return rule.find && pattern ? name.replace(pattern, rule.replace) : name;
    case "add":
      return rule.where === "before" ? `${rule.text}${stem}${ext}` : `${stem}${rule.text}${ext}`;
    case "format": {
      const n = String(rule.start + index).padStart(Math.max(1, rule.digits), "0");
      return rule.where === "before" ? `${n}${rule.base}${ext}` : `${rule.base}${n}${ext}`;
    }
  }
}

function problemWith(name: string): string | null {
  if (!name.trim()) return msg("Empty name");
  if (name === "." || name === "..") return msg("Reserved name");
  if (name.includes("/")) return msg("Contains “/”");
  if (name.includes(":")) return msg("Contains “:”");
  if (new TextEncoder().encode(name).length > 255) return msg("Too long");
  return null;
}

/**
 * New names for `items` (in their on-screen order), with problems flagged:
 * invalid names, two items ending up with the same name in one folder, or a
 * name taken by another item in the folder (`siblings`, as `siblingKey`s).
 */
export function previewRenames(
  items: readonly { path: string; name: string; isFolder: boolean }[],
  rule: RenameRule,
  siblings: ReadonlySet<string>,
): RenamePreview[] {
  const compiled = rule.kind === "replace" ? findPattern(rule) : null;
  const pattern = compiled instanceof RegExp ? compiled : null;
  const out = items.map((item, i) => {
    const next = newName(item.name, item.isFolder, rule, i, pattern);
    return { path: item.path, name: item.name, newName: next, problem: problemWith(next) };
  });
  const dir = (p: { path: string }) => parent(p.path) ?? "/";
  const renamedAway = new Set(out.filter((p) => p.newName !== p.name).map((p) => siblingKey(dir(p), p.name)));
  const counts = new Map<string, number>();
  for (const p of out) {
    const key = siblingKey(dir(p), p.newName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const p of out) {
    if (p.problem || p.newName === p.name) continue;
    const key = siblingKey(dir(p), p.newName);
    if ((counts.get(key) ?? 0) > 1) p.problem = msg("Same name as another item");
    else if (siblings.has(key) && !renamedAway.has(key) && key !== siblingKey(dir(p), p.name))
      p.problem = msg("An item with this name already exists");
  }
  return out;
}
