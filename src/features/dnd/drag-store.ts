import { create } from "zustand";

interface DragState {
  /** In-app drag in progress (pointer-driven, not an OS drag session). */
  active: boolean;
  count: number;
  x: number;
  y: number;
  /** Folder under the pointer that would receive the drop, or FAVORITES_TARGET. */
  target: string | null;
  copy: boolean;
}

/** The sidebar's Favorites list: a drop there adds the dragged folders. */
export const FAVORITES_TARGET = "favorites:";

export const useDrag = create<DragState>()(() => ({
  active: false,
  count: 0,
  x: 0,
  y: 0,
  target: null,
  copy: false,
}));
