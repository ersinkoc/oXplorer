import { commands } from "@/bindings";
import { defineCommands } from "@/commands/registry";
import { realFolder } from "@/lib/search-path";
import { shellQuote } from "@/lib/shell";
import { useApp } from "@/stores/app-store";
import { useTerminals } from "@/stores/terminal-store";
import { getActiveTab } from "@/stores/workspace-store";

/** Opens a shell in `cwd` (the active pane's folder by default) and shows the panel. */
export function openTerminal(cwd = defaultTerminalFolder()): void {
  useApp.getState().setPreference("terminalVisible", true);
  useTerminals.getState().open(cwd);
}

function defaultTerminalFolder(): string {
  const { terminalStartIn, home } = useApp.getState();
  return terminalStartIn === "home" ? home : realFolder(getActiveTab().path);
}

export function closeTerminal(id: string): void {
  useTerminals.getState().close(id);
  if (useTerminals.getState().sessions.length === 0)
    useApp.getState().setPreference("terminalVisible", false);
}

export function registerTerminalCommands(): void {
  defineCommands([
    {
      id: "terminal.toggle",
      title: "Show Terminal",
      run: () => {
        const { terminalVisible, setPreference } = useApp.getState();
        if (terminalVisible) return setPreference("terminalVisible", false);
        if (useTerminals.getState().sessions.length === 0) return openTerminal();
        setPreference("terminalVisible", true);
        useTerminals.getState().focus();
      },
    },
    { id: "terminal.new", title: "New Terminal", run: () => openTerminal() },
    {
      id: "terminal.cdToPane",
      title: "Go to Folder in Terminal",
      run: () => {
        const { activeId, sessions } = useTerminals.getState();
        const session = sessions.find((s) => s.id === activeId && !s.exited);
        if (!session) return openTerminal();
        useApp.getState().setPreference("terminalVisible", true);
        // ⌃U first clears whatever is typed at the prompt.
        void commands.ptyWrite(session.id, `\x15cd -- ${shellQuote(realFolder(getActiveTab().path))}\r`);
        useTerminals.getState().focus();
      },
    },
  ]);
}
