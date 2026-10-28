import { describe, expect, it } from "vitest";
import { squarify } from "@/lib/treemap";

const area = (r: { w: number; h: number }) => r.w * r.h;

describe("squarify", () => {
  const rect = { x: 0, y: 0, w: 600, h: 400 };
  const items = [6, 6, 4, 3, 2, 2, 1].map((value, i) => ({ value, item: `i${i}` }));

  it("fills the rectangle with areas proportional to the values", () => {
    const cells = squarify(items, rect);
    expect(cells).toHaveLength(7);
    const total = cells.reduce((s, c) => s + area(c.rect), 0);
    expect(total).toBeCloseTo(600 * 400, 3);
    const unit = (600 * 400) / 24;
    for (const c of cells) {
      const value = items.find((i) => i.item === c.item)?.value ?? 0;
      expect(area(c.rect)).toBeCloseTo(value * unit, 3);
    }
  });

  it("stays inside the rectangle and keeps cells reasonably square", () => {
    for (const c of squarify(items, rect)) {
      expect(c.rect.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.rect.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.rect.x + c.rect.w).toBeLessThanOrEqual(600 + 1e-9);
      expect(c.rect.y + c.rect.h).toBeLessThanOrEqual(400 + 1e-9);
      expect(Math.max(c.rect.w / c.rect.h, c.rect.h / c.rect.w)).toBeLessThan(4);
    }
  });

  it("skips empty items and empty space", () => {
    expect(squarify([{ value: 0, item: "a" }], rect)).toEqual([]);
    expect(squarify(items, { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
  });
});
