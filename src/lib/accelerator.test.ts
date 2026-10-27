import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, formatAccelerator, normalizeAccelerator } from "@/lib/accelerator";

const key = (
  code: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {},
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("accelerators", () => {
  it("records shortcuts from physical keys", () => {
    expect(acceleratorFromEvent(key("KeyN", { metaKey: true, shiftKey: true }))).toBe("Shift+CmdOrCtrl+N");
    expect(acceleratorFromEvent(key("Digit3", { metaKey: true, altKey: true }))).toBe("Alt+CmdOrCtrl+3");
    expect(acceleratorFromEvent(key("Backquote", { ctrlKey: true }))).toBe("Ctrl+Backquote");
    expect(acceleratorFromEvent(key("F5"))).toBe("F5");
  });

  it("ignores plain keys and lone modifiers", () => {
    expect(acceleratorFromEvent(key("KeyA"))).toBeNull();
    expect(acceleratorFromEvent(key("KeyA", { shiftKey: true }))).toBeNull();
    expect(acceleratorFromEvent(key("MetaLeft", { metaKey: true }))).toBeNull();
  });

  it("formats with Mac symbols in menu order", () => {
    expect(formatAccelerator("Shift+CmdOrCtrl+N")).toBe("⇧⌘N");
    expect(formatAccelerator("Alt+CmdOrCtrl+Backspace")).toBe("⌥⌘⌫");
    expect(formatAccelerator("Ctrl+Shift+Tab")).toBe("⌃⇧⇥");
    expect(formatAccelerator("CmdOrCtrl+BracketLeft")).toBe("⌘[");
    expect(normalizeAccelerator("Cmd+Shift+n")).toBe(normalizeAccelerator("Shift+CmdOrCtrl+N"));
  });
});
