/**
 * Menu shortcuts in the accelerator syntax the native menu takes
 * ("Shift+CmdOrCtrl+N"), recorded from key events and shown with Mac symbols.
 */

const CODE_KEYS: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backspace: "Backspace",
  Delete: "Delete",
  Enter: "Enter",
  Tab: "Tab",
  Space: "Space",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backslash: "Backslash",
  Minus: "Minus",
  Equal: "Equal",
  Backquote: "Backquote",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

/** Physical key → accelerator key name (layout-independent, like the menu). */
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|20)$/.test(code)) return code;
  return CODE_KEYS[code] ?? null;
}

/**
 * The accelerator for a key press, or null when it isn't a usable shortcut
 * (a lone modifier, or a plain key without ⌘/⌃/⌥ — function keys excepted).
 */
export function acceleratorFromEvent(
  e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const isFunctionKey = /^F\d+$/.test(key);
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !isFunctionKey) return null;
  const mods = [
    e.shiftKey && "Shift",
    e.ctrlKey && "Ctrl",
    e.altKey && "Alt",
    e.metaKey && "CmdOrCtrl",
  ].filter(Boolean);
  return [...mods, key].join("+");
}

const SYMBOLS: Record<string, string> = {
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Tab: "⇥",
  Space: "Space",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

/** "Shift+CmdOrCtrl+N" → "⇧⌘N", in the order macOS menus use (⌃⌥⇧⌘). */
export function formatAccelerator(accel: string): string {
  const parts = accel.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const has = (...names: string[]) => names.some((n) => mods.has(n));
  return (
    (has("ctrl", "control") ? "⌃" : "") +
    (has("alt", "option") ? "⌥" : "") +
    (has("shift") ? "⇧" : "") +
    (has("cmdorctrl", "cmd", "command", "super", "commandorcontrol") ? "⌘" : "") +
    (SYMBOLS[key] ?? key.toUpperCase())
  );
}

/** Same shortcut regardless of how it was spelled ("Cmd+Shift+n" = "Shift+CmdOrCtrl+N"). */
export function normalizeAccelerator(accel: string): string {
  return formatAccelerator(accel);
}
