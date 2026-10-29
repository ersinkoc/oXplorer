import { describe, expect, it } from "vitest";
import { defaultAction, join } from "@/features/sync/sync-dialog";

describe("sync", () => {
  it("picks the newer side both ways and never deletes", () => {
    expect(defaultAction("leftOnly", "both")).toBe("toRight");
    expect(defaultAction("rightNewer", "both")).toBe("toLeft");
    expect(defaultAction("differs", "both")).toBe("skip");
    // One way: the source side wins, extra items on the other side stay.
    expect(defaultAction("rightNewer", "toRight")).toBe("toRight");
    expect(defaultAction("rightOnly", "toRight")).toBe("skip");
    expect(defaultAction("leftOnly", "toLeft")).toBe("skip");
  });

  it("joins below the root", () => {
    expect(join("/", "a/b")).toBe("/a/b");
    expect(join("/x", "a")).toBe("/x/a");
  });
});
