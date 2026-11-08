import { events } from "@/bindings";
import { focusedTextField } from "@/lib/text-edit";

/**
 * Single source for every user-invocable action. The native menu, keyboard
 * shortcuts and (later) the command palette and context menus all dispatch
 * through `runCommand`, so behavior never diverges between entry points.
 */
export interface Command {
  id: string;
  title: string;
  run: () => void | Promise<void>;
}

const registry = new Map<string, Command>();

export function defineCommands(list: readonly Command[]): void {
  // Later definitions win, which is also what makes HMR re-registration work.
  for (const cmd of list) registry.set(cmd.id, cmd);
}

export function runCommand(id: string): void {
  const cmd = registry.get(id);
  if (!cmd) {
    console.warn(`unknown command ${id}`);
    return;
  }
  Promise.resolve(cmd.run()).catch((err: unknown) => console.error(`command ${id} failed`, err));
}

export function listCommands(): Command[] {
  return [...registry.values()];
}

/** Text editing, which goes to the focused field of a dialog. */
const TEXT_EDITS = new Set([
  "edit.copy",
  "edit.cut",
  "edit.paste",
  "edit.undo",
  "edit.redo",
  "edit.selectAll",
]);
/** Commands that don't touch the panes and open their own windows. */
const DIALOG_SAFE = new Set([
  "app.settings",
  "app.checkUpdates",
  "help.whatsNew",
  "help.report",
  "help.showLog",
]);

/** A modal dialog is open; the panes behind it are inert. */
export function dialogOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

/**
 * Whether `id` may run now. With a dialog open, ⌘⌫ or ⌘D must not act on the
 * files selected behind it; only text editing in its fields and app windows run.
 */
export function allowedNow(id: string): boolean {
  if (!dialogOpen()) return true;
  return DIALOG_SAFE.has(id) || (TEXT_EDITS.has(id) && focusedTextField() !== null);
}

/**
 * Routes native menu clicks/accelerators into the registry. The menu bar is
 * shared by all windows, so commands only run when this window is in front
 * (otherwise ⌘D in the Settings window would duplicate the selected files).
 */
export function listenToMenu(): Promise<() => void> {
  return events.menuCommand.listen((e) => {
    if (document.hasFocus() && allowedNow(e.payload.id)) runCommand(e.payload.id);
  });
}
