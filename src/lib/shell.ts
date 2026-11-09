const isControl = (c: string) => {
  const code = c.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
};

/**
 * Quotes a path for POSIX shells: 'it'\''s here'. Names with control characters
 * use $'…' with \xHH escapes: typed raw, an ESC could end a bracketed paste and
 * a newline would run what follows.
 */
export function shellQuote(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path;
  if (![...path].some(isControl)) return `'${path.replace(/'/g, `'\\''`)}'`;
  const escaped = [...path]
    .map((c) =>
      c === "\\" || c === "'"
        ? `\\${c}`
        : isControl(c)
          ? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`
          : c,
    )
    .join("");
  return `$'${escaped}'`;
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
