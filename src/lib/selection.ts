import { compareNames } from "@/lib/sort";

/** Selection is keyed by path; `order` is the currently visible order of paths. */
export interface Selection {
  paths: ReadonlySet<string>;
  /** Fixed end of a shift-range. */
  anchor: string | null;
  /** Keyboard cursor / last clicked item. */
  focus: string | null;
}

export const EMPTY_SELECTION: Selection = { paths: new Set(), anchor: null, focus: null };

export type ClickMode = "single" | "toggle" | "range";

export function selectOne(path: string): Selection {
  return { paths: new Set([path]), anchor: path, focus: path };
}

function range(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a === -1 || b === -1) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export function click(sel: Selection, order: readonly string[], path: string, mode: ClickMode): Selection {
  switch (mode) {
    case "single":
      return selectOne(path);
    case "toggle": {
      const paths = new Set(sel.paths);
      if (paths.has(path)) paths.delete(path);
      else paths.add(path);
      return { paths, anchor: path, focus: path };
    }
    case "range": {
      const anchor = sel.anchor ?? path;
      return { paths: new Set(range(order, anchor, path)), anchor, focus: path };
    }
  }
}

/** Arrow-key movement. `extend` (shift) grows/shrinks the range from the anchor. */
export function move(sel: Selection, order: readonly string[], delta: number, extend: boolean): Selection {
  if (order.length === 0) return sel;
  const cur = sel.focus ? order.indexOf(sel.focus) : -1;
  let next: number;
  if (cur === -1) next = delta > 0 ? 0 : order.length - 1;
  else next = Math.max(0, Math.min(order.length - 1, cur + delta));
  const target = order[next];
  if (target === undefined) return sel;
  if (!extend) return selectOne(target);
  const anchor = sel.anchor ?? target;
  return { paths: new Set(range(order, anchor, target)), anchor, focus: target };
}

export function selectAll(order: readonly string[]): Selection {
  return { paths: new Set(order), anchor: order[0] ?? null, focus: order.at(-1) ?? null };
}

/** Drops paths that are no longer visible (filtered, deleted, hidden toggled). */
export function prune(sel: Selection, visible: ReadonlySet<string>): Selection {
  let changed = false;
  const paths = new Set<string>();
  for (const p of sel.paths) {
    if (visible.has(p)) paths.add(p);
    else changed = true;
  }
  const focus = sel.focus && visible.has(sel.focus) ? sel.focus : null;
  const anchor = sel.anchor && visible.has(sel.anchor) ? sel.anchor : null;
  if (!changed && focus === sel.focus && anchor === sel.anchor) return sel;
  return { paths, anchor, focus };
}

/**
 * Type-ahead: first visible name that starts with `prefix`, or else the first name
 * that sorts after it (what Finder does when nothing matches exactly).
 */
export function typeAheadMatch(
  names: readonly { name: string; path: string }[],
  prefix: string,
): string | null {
  const p = prefix.toLocaleLowerCase();
  const starts = names.find((n) => n.name.toLocaleLowerCase().startsWith(p));
  if (starts) return starts.path;
  const after = names
    .filter((n) => compareNames(n.name, prefix) > 0)
    .sort((a, b) => compareNames(a.name, b.name));
  return after[0]?.path ?? null;
}
