import { create } from "zustand";

interface DragState {
  /** In-app drag in progress (pointer-driven, not an OS drag session). */
  active: boolean;
  count: number;
  x: number;
  y: number;
  /** Folder under the pointer that would receive the drop. */
  target: string | null;
  copy: boolean;
}

export const useDrag = create<DragState>()(() => ({
  active: false,
  count: 0,
  x: 0,
  y: 0,
  target: null,
  copy: false,
}));
