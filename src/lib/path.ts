/** POSIX path helpers for absolute macOS paths. Inputs are assumed normalized by Rust. */

export function basename(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Parent directory, or `null` for the root. */
export function parent(path: string): string | null {
  if (path === "/") return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

export function join(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export interface PathSegment {
  name: string;
  path: string;
}

/** `/Users/a/b` → `[/, Users, a, b]` with the cumulative path for each. */
export function segments(path: string): PathSegment[] {
  const out: PathSegment[] = [{ name: "/", path: "/" }];
  let acc = "";
  for (const part of path.split("/")) {
    if (!part) continue;
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
}

/** Expands a leading `~` and strips trailing slashes. Returns `null` for relative input. */
export function normalizeUserInput(input: string, home: string): string | null {
  let p = input.trim();
  if (!p) return null;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  if (!p.startsWith("/")) return null;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Display path with the home directory abbreviated as `~`. */
export function tildify(path: string, home: string): string {
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
