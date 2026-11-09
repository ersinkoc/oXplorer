import type { Terminal } from "@xterm/xterm";
import { commands } from "@/bindings";

/** Live xterm instances by session id, so menu commands can reach them. */
const terminals = new Map<string, Terminal>();

export function registerTerminal(id: string, term: Terminal): () => void {
  terminals.set(id, term);
  return () => terminals.delete(id);
}

export function terminalById(id: string): Terminal | undefined {
  return terminals.get(id);
}

/** The terminal holding keyboard focus, with its session id. */
export function focusedTerminal(): { id: string; term: Terminal } | null {
  const el = document.activeElement?.closest<HTMLElement>("[data-terminal-id]");
  const id = el?.dataset.terminalId;
  const term = id ? terminals.get(id) : undefined;
  return id && term ? { id, term } : null;
}

/**
 * Types text into a session as if pasted (bracketed paste when the app asked for it).
 * ESC is dropped: pasted text containing ESC[201~ would end the paste early and
 * the rest would run as typed keys.
 */
export function pasteInto(id: string, raw: string): void {
  const text = raw.split("\x1b").join("");
  const term = terminals.get(id);
  if (term) term.paste(text);
  else void commands.ptyWrite(id, text);
}
