import { describe, expect, it } from "vitest";
import { fromDateInput, toDateInput } from "./date-input";

describe("date inputs", () => {
  it("round-trips to the second", () => {
    const ms = new Date(2001, 1, 3, 4, 5, 6).getTime();
    expect(toDateInput(ms)).toBe("2001-02-03T04:05:06");
    expect(fromDateInput(toDateInput(ms))).toBe(ms);
  });

  it("takes minutes without seconds and refuses junk", () => {
    expect(fromDateInput("2001-02-03T04:05")).toBe(new Date(2001, 1, 3, 4, 5).getTime());
    expect(fromDateInput("")).toBeNull();
    expect(fromDateInput("yesterday")).toBeNull();
    expect(fromDateInput("1960-01-01T00:00")).toBeNull();
  });
});
