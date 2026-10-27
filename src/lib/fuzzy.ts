/**
 * Subsequence match score for the command palette, or null when `query`
 * isn't a subsequence of `text`. Consecutive characters and matches at word
 * starts score higher; shorter texts win ties.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    const wordStart = at === 0 || /[\s/._-]/.test(t[at - 1] ?? "");
    score += 1 + (at === prev + 1 ? 3 : 0) + (wordStart ? 2 : 0);
    prev = at;
    ti = at + 1;
  }
  return score - t.length * 0.01;
}
