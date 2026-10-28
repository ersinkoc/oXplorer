import { GitBranch, Link2 } from "lucide-react";
import { useEffect, useState } from "react";
import { commands } from "@/bindings";
import { useVisibleEntries } from "@/features/file-view/use-visible-entries";
import { useT } from "@/i18n";
import { formatSize, isFolderLike } from "@/lib/format";
import { useApp } from "@/stores/app-store";
import { useCompareMarks } from "@/stores/compare-store";
import { useFolderSizes } from "@/stores/folder-size-store";
import { useGit } from "@/stores/git-store";
import { type PaneId, useWorkspace } from "@/stores/workspace-store";

export function StatusBar({ pane }: { pane: PaneId }) {
  const { t, tn } = useT();
  const { tab, entries, dir } = useVisibleEntries(pane);
  const [available, setAvailable] = useState<number | null>(null);
  const showGit = useApp((s) => s.showGitStatus);
  const compare = useCompareMarks(pane);
  const syncBrowse = useApp((s) => s.syncBrowse);
  const dualPane = useWorkspace((s) => s.dualPane);
  const synced = syncBrowse && dualPane;
  const sizes = useFolderSizes((s) => s.sizes);
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
  // Folders count once View → Calculate Folder Sizes measured them.
  const selectedBytes = selected.reduce(
    (sum, e) => sum + (isFolderLike(e) ? (sizes[e.path]?.bytes ?? 0) : e.size),
    0,
  );
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
  if (compare) {
    const count = (m: string) => [...compare.values()].filter((v) => v === m).length;
    parts.push(
      t("comparing: {only} only here, {newer} newer, {different} different", {
        only: count("only"),
        newer: count("newer"),
        different: count("different"),
      }),
    );
  } else if (available !== null) parts.push(t("{size} available", { size: formatSize(available) }));

  return (
    <footer className="relative flex h-[24px] shrink-0 items-center justify-center border-t border-border bg-toolbar px-3 text-[11px] text-fg-muted">
      {parts.join(", ")}
      {branch && (
        <span title={t("Git branch")} className="absolute left-3 flex max-w-[30%] items-center gap-1">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      {synced && (
        <span
          title={t("Synchronized Browsing")}
          className="absolute right-3 flex items-center gap-1 text-accent"
        >
          <Link2 aria-hidden className="size-3" />
          {t("Synced")}
        </span>
      )}
    </footer>
  );
}
