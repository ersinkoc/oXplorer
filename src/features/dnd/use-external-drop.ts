import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { runJob } from "@/commands/jobs";
import { useDrag } from "@/features/dnd/drag-store";
import { dropDirAt, dropMode, isValidDrop } from "@/features/dnd/drop-target";
import { getActiveTab } from "@/stores/workspace-store";

/** Files dragged in from Finder or other apps (an OS drag session). */
export function useExternalDrop(): void {
  useEffect(() => {
    let paths: string[] = [];
    const targetAt = (pos: { x: number; y: number }): string => {
      // Positions arrive in physical pixels.
      const r = window.devicePixelRatio || 1;
      return dropDirAt(pos.x / r, pos.y / r) ?? getActiveTab().path;
    };
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      switch (payload.type) {
        case "enter":
          paths = payload.paths;
          useDrag.setState({ target: targetAt(payload.position) });
          break;
        case "over": {
          const dir = targetAt(payload.position);
          useDrag.setState({ target: isValidDrop(paths, dir) ? dir : null });
          break;
        }
        case "drop": {
          const dir = targetAt(payload.position);
          useDrag.setState({ target: null });
          if (payload.paths.length > 0 && isValidDrop(payload.paths, dir)) {
            void runJob({ kind: dropMode(payload.paths, dir, false), sources: payload.paths, destDir: dir });
          }
          break;
        }
        case "leave":
          useDrag.setState({ target: null });
          break;
      }
    });
    return () => void unlisten.then((fn) => fn());
  }, []);
}
