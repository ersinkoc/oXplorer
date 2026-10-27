/** Quotes a path for POSIX shells: 'it'\''s here'. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Paths as typed after a drop into the terminal: quoted, space-separated, trailing space. */
export function shellArgs(paths: readonly string[]): string {
  return `${paths.map(shellQuote).join(" ")} `;
}

/**
 * The directory from an OSC 7 report (`file://host/path`), or null.
 * Only local reports are accepted: a remote shell (ssh) reports its own host.
 */
export function parseOsc7(data: string, localHosts: readonly string[] = []): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)$/.exec(data);
  if (!m) return null;
  const [, host = "", path = ""] = m;
  const local =
    host === "" || host === "localhost" || localHosts.some((h) => h.toLowerCase() === host.toLowerCase());
  if (!local) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}
