import { debug } from "@tauri-apps/plugin-log";
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { commands, events } from "@/bindings";
import { isSearchPath } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { activeTabOf, useWorkspace } from "@/stores/workspace-store";

/** Mount/unmount shows up as entries appearing in /Volumes. */
const VOLUMES_DIR = "/Volumes";

/** Paths this window currently has a watch on (Rust ref-counts per call). */
const watched = new Set<string>();

async function refreshVolumes(): Promise<void> {
  const res = await commands.listVolumes();
  if (res.status !== "ok") return;
  useApp.getState().set({ volumes: res.data });
  void debug(`volumes: ${res.data.map((v) => v.name).join(", ")}`);
}

/**
 * Keeps a watch on every directory visible in a pane, applies watcher deltas to
 * the directory cache, and refreshes the sidebar when volumes come and go.
 */
export function useLiveDirs(): void {
  const visible = useWorkspace(
    useShallow((s) => {
      const panes = s.dualPane ? [s.panes.left, s.panes.right] : [s.panes.left];
      const paths = panes.map((p) => activeTabOf(p).path).filter((p) => !isSearchPath(p));
      return [...new Set([...paths, VOLUMES_DIR])].sort();
    }),
  );

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = events.dirChanged.listen(({ payload }) => {
      useDirCache.getState().applyChange(payload);
      if (payload.dir === VOLUMES_DIR) {
        // A mount produces several events in a row; refresh once.
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refreshVolumes(), 300);
      }
    });
    return () => {
      clearTimeout(refreshTimer);
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const next = new Set(visible);
    for (const path of watched) {
      if (!next.has(path)) {
        watched.delete(path);
        void commands.unwatchDir(path);
      }
    }
    for (const path of next) {
      if (watched.has(path)) continue;
      watched.add(path);
      void commands.watchDir(path).then((r) => {
        // Unreadable folders can't be watched; the pane already shows the error.
        if (r.status === "error") watched.delete(path);
      });
    }
  }, [visible]);
}
