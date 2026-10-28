export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): lays out `items` inside
 * `rect` with areas proportional to their values, keeping cells close to
 * square. Items with a value of 0 get no cell.
 */
export function squarify<T>(
  items: readonly { value: number; item: T }[],
  rect: Rect,
): { rect: Rect; item: T }[] {
  const list = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const total = list.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const areas = list.map((i) => ({ area: i.value * scale, item: i.item }));
  const out: { rect: Rect; item: T }[] = [];
  let free = { ...rect };

  /** Largest aspect ratio in a row of `areas` laid along a side of length `side`. */
  const worst = (row: readonly number[], side: number) => {
    const sum = row.reduce((s, a) => s + a, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  const place = (row: typeof areas) => {
    const sum = row.reduce((s, a) => s + a.area, 0);
    if (free.w >= free.h) {
      // A column on the left.
      const w = sum / free.h;
      let y = free.y;
      for (const a of row) {
        const h = a.area / w;
        out.push({ rect: { x: free.x, y, w, h }, item: a.item });
        y += h;
      }
      free = { x: free.x + w, y: free.y, w: free.w - w, h: free.h };
    } else {
      // A row along the top.
      const h = sum / free.w;
      let x = free.x;
      for (const a of row) {
        const w = a.area / h;
        out.push({ rect: { x, y: free.y, w, h }, item: a.item });
        x += w;
      }
      free = { x: free.x, y: free.y + h, w: free.w, h: free.h - h };
    }
  };

  let row: typeof areas = [];
  for (const a of areas) {
    const side = Math.min(free.w, free.h);
    const current = row.map((r) => r.area);
    if (row.length === 0 || worst([...current, a.area], side) <= worst(current, side)) {
      row.push(a);
    } else {
      place(row);
      row = [a];
    }
  }
  if (row.length > 0) place(row);
  return out;
}
