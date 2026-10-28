import { useRef } from "react";
import { PreviewPane } from "@/features/preview/preview-pane";
import { Pane } from "@/features/workspace/pane";
import { Splitter } from "@/features/workspace/splitter";
import { useT } from "@/i18n";
import { PREVIEW_LIMITS, useWorkspace } from "@/stores/workspace-store";

/** Panes side by side, then the preview column. */
export function Workspace() {
  const { t } = useT();
  const dual = useWorkspace((s) => s.dualPane);
  const split = useWorkspace((s) => s.split);
  const preview = useWorkspace((s) => s.preview);
  const panesRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const onSplitDrag = (x: number) => {
    const r = panesRef.current?.getBoundingClientRect();
    if (r && r.width > 0) useWorkspace.getState().setSplit((x - r.left) / r.width);
  };
  const onPreviewDrag = (x: number) => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) useWorkspace.getState().setPreview({ width: Math.min(r.right - x, r.width * 0.6) });
  };

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1">
      <div ref={panesRef} className="flex min-w-0 flex-1">
        <Pane pane="left" style={{ flex: dual ? `${split} 1 0` : "1 1 0" }} />
        {dual && (
          <>
            <Splitter
              label={t("Resize panes")}
              value={split * 100}
              onDrag={onSplitDrag}
              onReset={() => useWorkspace.getState().setSplit(0.5)}
            />
            <Pane pane="right" style={{ flex: `${1 - split} 1 0` }} />
          </>
        )}
      </div>
      {preview.visible && (
        <>
          <Splitter
            label={t("Resize preview")}
            value={(preview.width / PREVIEW_LIMITS.max) * 100}
            onDrag={onPreviewDrag}
            onReset={() => useWorkspace.getState().setPreview({ width: PREVIEW_LIMITS.default })}
          />
          <PreviewPane width={preview.width} />
        </>
      )}
    </div>
  );
}
