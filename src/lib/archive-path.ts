import { basename, parent } from "@/lib/path";

/**
 * Archives are browsed like folders under a virtual path:
 * `archive:/Users/me/a.zip!/docs/img` (the part after `!/` is inside the archive).
 */
const PREFIX = "archive:";
const SEP = "!/";

const SUFFIXES = [".zip", ".tar", ".tar.gz", ".tgz", ".tar.zst", ".tzst"];

/** Archives OXplorer can open and extract (the same list as `jobs/archive.rs`). */
export function isArchiveName(name: string): boolean {
  const n = name.toLowerCase();
  return SUFFIXES.some((s) => n.endsWith(s) && n.length > s.length);
}

export function isArchivePath(path: string): boolean {
  return path.startsWith(PREFIX);
}

export function archivePath(archive: string, inner = ""): string {
  return `${PREFIX}${archive}${SEP}${inner}`;
}

export function parseArchivePath(path: string): { archive: string; inner: string } | null {
  if (!isArchivePath(path)) return null;
  const rest = path.slice(PREFIX.length);
  const at = rest.indexOf(SEP);
  const archive = at < 0 ? rest.replace(/!$/, "") : rest.slice(0, at);
  if (!archive.startsWith("/")) return null;
  const inner = at < 0 ? "" : rest.slice(at + SEP.length).replace(/^\/+|\/+$/g, "");
  return { archive, inner };
}

/** One level up inside the archive, or the archive's own folder at its root. */
export function archiveParent(path: string): { path: string; select: string | null } | null {
  const p = parseArchivePath(path);
  if (!p) return null;
  if (!p.inner) return { path: parent(p.archive) ?? "/", select: p.archive };
  const up = p.inner.includes("/") ? p.inner.slice(0, p.inner.lastIndexOf("/")) : "";
  return { path: archivePath(p.archive, up), select: path };
}

/** "a.zip" or the name of the folder inside it. */
export function archiveTitle(path: string): string {
  const p = parseArchivePath(path);
  if (!p) return basename(path);
  return p.inner ? basename(p.inner) : basename(p.archive);
}
