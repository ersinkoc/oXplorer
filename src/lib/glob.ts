/**
 * Matcher for "Select Matching…": `*.jpg; *.png` style patterns separated by
 * `;` or `,`. `*` is any run of characters and `?` one character. A pattern
 * without wildcards matches names that contain it. Case-insensitive and
 * Unicode-normalized, since macOS stores names decomposed.
 */
export function globMatcher(input: string): ((name: string) => boolean) | null {
  const patterns = input
    .split(/[;,]/)
    .map((p) => p.trim().normalize("NFC").toLocaleLowerCase())
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
    const n = name.normalize("NFC").toLocaleLowerCase();
    return tests.some((test) => test(n));
  };
}
