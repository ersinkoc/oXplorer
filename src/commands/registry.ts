import { events } from "@/bindings";

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

/** Routes native menu clicks/accelerators into the registry. */
export function listenToMenu(): Promise<() => void> {
  return events.menuCommand.listen((e) => runCommand(e.payload.id));
}
