import { useEffect, useState } from "react";
import { commands } from "@/bindings";
import { useVisibleEntries } from "@/features/file-view/use-visible-entries";
import { formatSize, isFolderLike } from "@/lib/format";
import type { PaneId } from "@/stores/workspace-store";

export function StatusBar({ pane }: { pane: PaneId }) {
  const { tab, entries, dir } = useVisibleEntries(pane);
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    let stale = false;
    void commands.spaceFor(tab.path).then((r) => {
      if (!stale) setAvailable(r.status === "ok" ? r.data.availableBytes : null);
    });
    return () => {
      stale = true;
    };
  }, [tab.path]);

  const selected = entries.filter((e) => tab.selection.paths.has(e.path));
  const selectedBytes = selected.reduce((sum, e) => sum + (isFolderLike(e) ? 0 : e.size), 0);
  const count = entries.length;

  const parts: string[] = [];
  if (selected.length > 0) {
    parts.push(`${selected.length} of ${count} selected`);
    if (selectedBytes > 0) parts.push(formatSize(selectedBytes));
  } else {
    parts.push(dir?.status === "loading" ? `${count} items…` : `${count} item${count === 1 ? "" : "s"}`);
  }
  if (available !== null) parts.push(`${formatSize(available)} available`);

  return (
    <footer className="flex h-[24px] shrink-0 items-center justify-center border-t border-border bg-toolbar px-3 text-[11px] text-fg-muted">
      {parts.join(", ")}
    </footer>
  );
}
