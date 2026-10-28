import type { SearchMode, SearchSpec } from "@/bindings";
import { t } from "@/i18n";
import { isArchivePath, parseArchivePath } from "@/lib/archive-path";
import { basename, parent } from "@/lib/path";
import { isRemotePath } from "@/lib/remote-path";
import { useApp } from "@/stores/app-store";

/**
 * Search results live in a tab like a folder, under a virtual path that
 * encodes the search (so history, sessions and new tabs just work):
 * `search:?q=report&mode=name&in=%2FUsers%2Fme&cs=1&re=1&hidden=1`.
 */
const PREFIX = "search:?";
const MODES: readonly SearchMode[] = ["name", "content", "spotlight", "tag"];

export function isSearchPath(path: string): boolean {
  return path.startsWith(PREFIX);
}

export function searchPath(spec: SearchSpec): string {
  const p = new URLSearchParams({ q: spec.query, mode: spec.mode, in: spec.scope });
  if (spec.caseSensitive) p.set("cs", "1");
  if (spec.regex) p.set("re", "1");
  if (spec.includeHidden) p.set("hidden", "1");
  return PREFIX + p.toString();
}

export function parseSearchPath(path: string): SearchSpec | null {
  if (!isSearchPath(path)) return null;
  const p = new URLSearchParams(path.slice(PREFIX.length));
  const mode = p.get("mode") as SearchMode | null;
  const scope = p.get("in");
  if (!scope?.startsWith("/") || !mode || !MODES.includes(mode)) return null;
  return {
    query: p.get("q") ?? "",
    mode,
    scope,
    caseSensitive: p.get("cs") === "1",
    regex: p.get("re") === "1",
    includeHidden: p.get("hidden") === "1",
  };
}

/** Search results and archive contents: shown like folders, but not on disk as such. */
export function isVirtualPath(path: string): boolean {
  return isSearchPath(path) || isArchivePath(path) || isRemotePath(path);
}

/**
 * The real folder behind a tab: a search's scope, an archive's folder, the path
 * itself — or, for a server, nothing local (Home stands in, e.g. for a terminal).
 */
export function realFolder(path: string): string {
  const search = parseSearchPath(path);
  if (search) return search.scope;
  const archive = parseArchivePath(path);
  if (archive) return parent(archive.archive) ?? "/";
  if (isRemotePath(path)) return useApp.getState().home;
  return path;
}

/** Short title for tabs and the path bar. */
export function searchTitle(spec: SearchSpec): string {
  if (spec.mode === "tag") return spec.query;
  const where = spec.scope === "/" ? t("Mac") : basename(spec.scope);
  return spec.query
    ? t("“{query}” in {where}", { query: spec.query, where })
    : t("Search in {where}", { where });
}
