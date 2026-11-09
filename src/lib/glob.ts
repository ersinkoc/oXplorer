/**
 * Case folding for matching names, the same in every system language
 * (toLocaleLowerCase would turn "I" into a dotless "ı" in Turkish): I, ı, İ
 * and i all match each other. NFC first, since macOS stores names decomposed.
 */
export function foldCase(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/i\u0307/g, "i")
    .replace(/ı/g, "i");
}

/**
 * Matcher for "Select Matching…": `*.jpg; *.png` style patterns separated by
 * `;` or `,` (a comma only separates once there's a wildcard or `;`, so
 * "Smith, John" stays one name). `*` is any run of characters and `?` one character. A pattern
 * without wildcards matches names that contain it. Case-insensitive and
 * Unicode-normalized, since macOS stores names decomposed.
 */
export function globMatcher(input: string): ((name: string) => boolean) | null {
  const patterns = input
    .split(/[*?;]/.test(input) ? /[;,]/ : /;/)
    .map((p) => foldCase(p.trim()))
    .filter(Boolean);
  if (patterns.length === 0) return null;
  const tests = patterns.map((p) => {
    if (!/[*?]/.test(p)) return (name: string) => name.includes(p);
    const source = p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const re = new RegExp(`^${source}$`, "su");
    return (name: string) => re.test(name);
  });
  return (name) => {
    const n = foldCase(name);
    return tests.some((test) => test(n));
  };
}
