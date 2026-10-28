/** One line of a diff; `a` / `b` are 1-based line numbers in the old / new file. */
export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
  a: number | null;
  b: number | null;
}

/**
 * Line diff (Myers, after trimming the common head and tail). Returns null when
 * the files differ in more than `maxEdits` lines, where it would get slow.
 */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = 1000): DiffLine[] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const middle = myers(A, B, maxEdits);
  if (!middle) return null;

  const out: DiffLine[] = [];
  let ai = 0;
  let bi = 0;
  const same = (text: string) => {
    ai++;
    bi++;
    out.push({ kind: "same", text, a: ai, b: bi });
  };
  for (let i = 0; i < head; i++) same(a[i] ?? "");
  for (const op of middle) {
    if (op.kind === "same") same(op.text);
    else if (op.kind === "del") out.push({ kind: "del", text: op.text, a: ++ai, b: null });
    else out.push({ kind: "add", text: op.text, a: null, b: ++bi });
  }
  for (let i = a.length - tail; i < a.length; i++) same(a[i] ?? "");
  return out;
}

type Op = { kind: DiffLine["kind"]; text: string };

function myers(A: readonly string[], B: readonly string[], maxEdits: number): Op[] | null {
  const n = A.length;
  const m = B.length;
  const limit = Math.min(n + m, maxEdits);
  const o = limit + 1;
  let v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v);
    v = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[o + k - 1] ?? 0) < (v[o + k + 1] ?? 0));
      let x = down ? (v[o + k + 1] ?? 0) : (v[o + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[o + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d] as Int32Array;
    const k = x - y;
    const down = k === -d || (k !== d && (prev[o + k - 1] ?? 0) < (prev[o + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[o + prevK] ?? 0;
    const prevY = prevX - prevK;
    while (x > (down ? prevX : prevX + 1) && y > (down ? prevY + 1 : prevY)) {
      ops.push({ kind: "same", text: A[--x] ?? "" });
      y--;
    }
    if (down) ops.push({ kind: "add", text: B[--y] ?? "" });
    else ops.push({ kind: "del", text: A[--x] ?? "" });
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "same", text: A[--x] ?? "" });
    y--;
  }
  return ops.reverse();
}

/** Lines to show: changes with `context` unchanged lines around them; gaps become `null`. */
export function withContext(lines: readonly DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Uint8Array(lines.length);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = 1;
  });
  const out: (DiffLine | null)[] = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out.at(-1) !== null) out.push(null);
  });
  return out;
}
