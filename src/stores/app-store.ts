import { LazyStore } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import type { Connection, FullDiskAccess, StandardLocation, VolumeInfo } from "@/bindings";
import type { FileEntry } from "@/lib/ipc";

export interface ColumnWidths {
  modified: number;
  size: number;
  kind: number;
}

export type Theme = "system" | "light" | "dark";

/** User preferences that survive restarts (edited in the Settings window). */
export interface Preferences {
  sidebarVisible: boolean;
  showHidden: boolean;
  columnWidths: ColumnWidths;
  terminalVisible: boolean;
  /** Height of the terminal panel in px. */
  terminalHeight: number;
  theme: Theme;
  /** UI language; "system" follows macOS. */
  languagePref: "system" | "en" | "tr";
  /** Where ⌘T opens: the current folder or Home. */
  newTabLocation: "current" | "home";
  /** Bring back tabs and layout at launch. */
  restoreSession: boolean;
  /** Git state badges in folders that belong to a repository. */
  showGitStatus: boolean;
  terminalFontSize: number;
  /** Where new terminals start. */
  terminalStartIn: "pane" | "home";
  /** Folders, saved searches and server folders the user added to the sidebar. */
  favorites: string[];
  /** Saved server connections (secrets are in the Keychain, not here). */
  connections: Connection[];
  /** Menu shortcut overrides by command id; null removes the shortcut. */
  shortcuts: Record<string, string | null>;
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
  paletteOpen: boolean;
  /** The resolved UI language (see `languagePref`). */
  language: "en" | "tr";
  whatsNewOpen: boolean;
  /** Folder shown in the Disk Usage window. */
  diskUsagePath: string | null;
  /** Items in the "Rename N Items" dialog. */
  batchRename: FileEntry[] | null;
  /** "Select Matching…" dialog: whether it adds to or removes from the selection. */
  selectMatching: "select" | "deselect" | null;
  /** Files in the Compare Files window (old, new). */
  compareFiles: [FileEntry, FileEntry] | null;
  /** Synchronized browsing: the other pane follows into subfolders and up. */
  syncBrowse: boolean;
  /** Folder searched in the Find Duplicates window. */
  duplicatesPath: string | null;
  /** Synchronize Folders between these two folders. */
  syncPair: { left: string; right: string } | null;

  set: (patch: Partial<AppState>) => void;
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
}

export const DEFAULT_PREFERENCES: Preferences = {
  sidebarVisible: true,
  showHidden: false,
  columnWidths: { modified: 190, size: 90, kind: 150 },
  terminalVisible: false,
  terminalHeight: 260,
  theme: "system",
  languagePref: "system",
  newTabLocation: "current",
  restoreSession: true,
  showGitStatus: true,
  terminalFontSize: 12,
  terminalStartIn: "pane",
  shortcuts: {},
  favorites: [],
  connections: [],
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
  paletteOpen: false,
  language: "en",
  whatsNewOpen: false,
  diskUsagePath: null,
  batchRename: null,
  selectMatching: null,
  syncBrowse: false,
  compareFiles: null,
  duplicatesPath: null,
  syncPair: null,

  set: (patch) => set(patch),
  setPreference: (key, value) => {
    set({ [key]: value } as Partial<AppState>);
    void store.set(key, value).catch((err: unknown) => console.warn("failed to persist", key, err));
  },
}));

/**
 * Keeps this window's preferences in sync with changes made elsewhere (the
 * Settings window writes the same store).
 */
export async function watchPreferences(): Promise<() => void> {
  const unlisten = await Promise.all(
    (Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[]).map((key) =>
      store.onKeyChange(key, (value) => {
        useApp.getState().set({ [key]: value ?? DEFAULT_PREFERENCES[key] } as Partial<AppState>);
      }),
    ),
  );
  return () => {
    for (const fn of unlisten) fn();
  };
}

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
