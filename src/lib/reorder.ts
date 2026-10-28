/** `list` with the item at `from` moved into the gap before index `gap` (0…length). */
export function moveToGap<T>(list: readonly T[], from: number, gap: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  if (item === undefined) return [...list];
  out.splice(gap > from ? gap - 1 : gap, 0, item);
  return out;
}
