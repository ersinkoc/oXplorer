import { create } from "zustand";
import type { UndoAction } from "@/bindings";

const LIMIT = 100;

interface HistoryState {
  undo: UndoAction[];
  redo: UndoAction[];
  /** A new user action: becomes undoable and invalidates the redo stack. */
  record: (action: UndoAction) => void;
  set: (patch: Partial<Pick<HistoryState, "undo" | "redo">>) => void;
}

export const useHistory = create<HistoryState>()((set) => ({
  undo: [],
  redo: [],
  record: (action) => set((s) => ({ undo: [...s.undo, action].slice(-LIMIT), redo: [] })),
  set: (patch) => set(patch),
}));
