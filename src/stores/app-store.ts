import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type { FullDiskAccess, StandardLocation, VolumeInfo } from "@/bindings";

export interface ColumnWidths {
  modified: number;
  size: number;
  kind: number;
}

/** User preferences that survive restarts. */
interface Preferences {
  sidebarVisible: boolean;
  showHidden: boolean;
  columnWidths: ColumnWidths;
}

interface AppState extends Preferences {
  home: string;
  locations: StandardLocation[];
  volumes: VolumeInfo[];
  fullDiskAccess: FullDiskAccess;
  fdaBannerDismissed: boolean;
  /** Path bar is in text-entry mode (⇧⌘G). */
  editingPath: boolean;
  /** Last ⌘C/⌘X in OXplorer; `cut` turns the next paste of the same files into a move. */
  clipboard: { paths: string[]; cut: boolean } | null;
  /** Item whose name is being edited inline. */
  renaming: string | null;
  /** Items shown in the Get Info panel. */
  infoPaths: string[] | null;

  set: (patch: Partial<AppState>) => void;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}

export const DEFAULT_PREFERENCES: Preferences = {
  sidebarVisible: true,
  showHidden: false,
  columnWidths: { modified: 190, size: 90, kind: 150 },
};

const store = new LazyStore("settings.json");

export const useApp = create<AppState>()((set) => ({
  ...DEFAULT_PREFERENCES,
  home: "/",
  locations: [],
  volumes: [],
  fullDiskAccess: "unknown",
  fdaBannerDismissed: false,
  editingPath: false,
  clipboard: null,
  renaming: null,
  infoPaths: null,

  set: (patch) => set(patch),
  setPreference: (key, value) => {
    set({ [key]: value } as Partial<AppState>);
    void store.set(key, value).catch((err: unknown) => console.warn("failed to persist", key, err));
  },
}));

export async function loadPreferences(): Promise<Partial<Preferences>> {
  const out: Partial<Preferences> = {};
  try {
    for (const key of Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]) {
      const value = await store.get(key);
      if (value !== undefined) Object.assign(out, { [key]: value });
    }
  } catch (err) {
    console.warn("failed to load preferences", err);
  }
  return out;
}
