import { tinykeys } from "tinykeys";
import { runCommand } from "@/commands/registry";

/**
 * Shortcuts that are NOT native-menu accelerators. Menu accelerators live in
 * `src-tauri/src/menu.rs`; binding them here too would fire commands twice.
 * Pane-local keys (arrows, type-ahead) are handled by the list view itself.
 */
export const GLOBAL_KEYS: Record<string, string> = {
  "$mod+ArrowDown": "file.open",
  // Digit codes: with ⌥ held, `key` is a symbol ("¡"), not the digit.
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`$mod+Alt+Digit${i + 1}`, `tab.goto.${i + 1}`])),
};

export function installGlobalKeys(): () => void {
  const bindings: Record<string, (e: KeyboardEvent) => void> = {};
  for (const [combo, id] of Object.entries(GLOBAL_KEYS)) {
    bindings[combo] = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      runCommand(id);
    };
  }
  return tinykeys(window, bindings);
}
