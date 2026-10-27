import { create } from "zustand";

export interface TerminalSession {
  id: string;
  /** Last directory the shell reported (OSC 7); the start folder until then. */
  cwd: string;
  /** "Link" mode: the active pane follows the shell's directory. */
  linked: boolean;
  exited: boolean;
}

interface TerminalState {
  sessions: TerminalSession[];
  activeId: string | null;
  /** Bumped to move keyboard focus into the active terminal. */
  focusSeq: number;

  open: (cwd: string) => string;
  close: (id: string) => void;
  activate: (id: string) => void;
  update: (id: string, patch: Partial<Omit<TerminalSession, "id">>) => void;
  focus: () => void;
}

export const useTerminals = create<TerminalState>()((set) => ({
  sessions: [],
  activeId: null,
  focusSeq: 0,

  open: (cwd) => {
    const id = `term-${crypto.randomUUID()}`;
    set((s) => ({
      sessions: [...s.sessions, { id, cwd, linked: false, exited: false }],
      activeId: id,
      focusSeq: s.focusSeq + 1,
    }));
    return id;
  },
  close: (id) =>
    set((s) => {
      const at = s.sessions.findIndex((t) => t.id === id);
      const sessions = s.sessions.filter((t) => t.id !== id);
      const activeId =
        s.activeId === id ? (sessions[Math.min(at, sessions.length - 1)]?.id ?? null) : s.activeId;
      return { sessions, activeId };
    }),
  activate: (id) => set((s) => ({ activeId: id, focusSeq: s.focusSeq + 1 })),
  update: (id, patch) =>
    set((s) => ({ sessions: s.sessions.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  focus: () => set((s) => ({ focusSeq: s.focusSeq + 1 })),
}));
