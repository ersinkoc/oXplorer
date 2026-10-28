import { create } from "zustand";
import { commands, type GitState, type GitStatus } from "@/bindings";
import { isVirtualPath } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";

interface GitStore {
  /** Folder path → its git status (`null` = not in a repository). */
  statuses: Record<string, GitStatus | null>;
}

export const useGit = create<GitStore>()(() => ({ statuses: {} }));

const REFRESH_DELAY_MS = 400;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
const again = new Set<string>();

async function load(path: string): Promise<void> {
  if (running.has(path)) {
    again.add(path);
    return;
  }
  running.add(path);
  try {
    const r = await commands.gitStatus(path);
    useGit.setState((s) => ({ statuses: { ...s.statuses, [path]: r.status === "ok" ? r.data : null } }));
  } finally {
    running.delete(path);
    if (again.delete(path)) void load(path);
  }
}

/** Refreshes a folder's git status soon; bursts of file changes coalesce. */
export function refreshGit(path: string, immediately = false): void {
  if (isVirtualPath(path) || !useApp.getState().showGitStatus) return;
  clearTimeout(timers.get(path));
  if (immediately) void load(path);
  else
    timers.set(
      path,
      setTimeout(() => void load(path), REFRESH_DELAY_MS),
    );
}

/** Refreshes every folder with a known status (after a terminal command, on focus). */
export function refreshAllGit(): void {
  for (const path of Object.keys(useGit.getState().statuses)) refreshGit(path);
}

/** State of `name` inside `dir`, or the folder's own state when it's wholly untracked/ignored. */
export function gitStateIn(status: GitStatus | null | undefined, name: string): GitState | undefined {
  if (!status) return undefined;
  return status.children.find((c) => c.name === name)?.state ?? status.folder ?? undefined;
}

/** Hook: name → state for a folder (empty when git status is off or unavailable). */
export function useGitStates(dir: string): ReadonlyMap<string, GitState> | null {
  const status = useGit((s) => s.statuses[dir]);
  const enabled = useApp((s) => s.showGitStatus);
  if (!enabled || !status) return null;
  return gitMap(status);
}

const maps = new WeakMap<GitStatus, Map<string, GitState>>();
function gitMap(status: GitStatus): Map<string, GitState> {
  let m = maps.get(status);
  if (!m) {
    m = new Map(status.children.map((c) => [c.name, c.state]));
    maps.set(status, m);
  }
  return m;
}
