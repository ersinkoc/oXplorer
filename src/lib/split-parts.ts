/** Numbered parts of a split file: `movie.mkv.001`, `movie.mkv.002`, … */
const PART = /^(.+)\.(\d{3})$/;

/** The first part (`.001`) of the set `name` belongs to, or null if it isn't a part. */
export function firstPart(path: string): string | null {
  const m = PART.exec(path);
  return m && Number(m[2]) >= 1 && !m[1]?.endsWith("/") ? `${m[1]}.001` : null;
}

/** How many parts `size` bytes make with parts of `partSize`. */
export function partCount(size: number, partSize: number): number {
  return partSize > 0 ? Math.ceil(size / partSize) : 0;
}

/** At most 999 parts, and at least two. */
export function canSplit(size: number, partSize: number): boolean {
  const n = partCount(size, partSize);
  return n >= 2 && n <= 999;
}
