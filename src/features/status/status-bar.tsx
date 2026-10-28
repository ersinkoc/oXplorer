import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { commands } from "@/bindings";
import { useVisibleEntries } from "@/features/file-view/use-visible-entries";
import { useT } from "@/i18n";
import { formatSize, isFolderLike } from "@/lib/format";
import { useApp } from "@/stores/app-store";
import { useGit } from "@/stores/git-store";
import type { PaneId } from "@/stores/workspace-store";

export function StatusBar({ pane }: { pane: PaneId }) {
  const { t, tn } = useT();
  const { tab, entries, dir } = useVisibleEntries(pane);
  const [available, setAvailable] = useState<number | null>(null);
  const showGit = useApp((s) => s.showGitStatus);
  const branch = useGit((s) => (showGit ? s.statuses[tab.path]?.branch : null));

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
    parts.push(
      t("{selected} of {total} selected", {
        selected: selected.length.toLocaleString(),
        total: count.toLocaleString(),
      }),
    );
    if (selectedBytes > 0) parts.push(formatSize(selectedBytes));
  } else {
    parts.push(
      dir?.status === "loading"
        ? t("{count} items…", { count: count.toLocaleString() })
        : tn(count, "{count} item", "{count} items"),
    );
  }
  if (available !== null) parts.push(t("{size} available", { size: formatSize(available) }));

  return (
    <footer className="relative flex h-[24px] shrink-0 items-center justify-center border-t border-border bg-toolbar px-3 text-[11px] text-fg-muted">
      {parts.join(", ")}
      {branch && (
        <span title={t("Git branch")} className="absolute left-3 flex max-w-[30%] items-center gap-1">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
    </footer>
  );
}
