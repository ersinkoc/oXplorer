import { CompareFilesDialog } from "@/features/compare/compare-files-dialog";
import { DragGhost } from "@/features/dnd/drag-ghost";
import { useExternalDrop } from "@/features/dnd/use-external-drop";
import { DuplicatesDialog } from "@/features/duplicates/duplicates-dialog";
import { WhatsNewDialog } from "@/features/help/whats-new";
import { InfoDialog } from "@/features/info/info-dialog";
import { ConflictDialog } from "@/features/jobs/conflict-dialog";
import { FdaBanner } from "@/features/layout/fda-banner";
import { Toolbar } from "@/features/navigation/toolbar";
import { CommandPalette } from "@/features/palette/command-palette";
import { BatchRenameDialog } from "@/features/rename/batch-rename-dialog";
import { SelectMatchingDialog } from "@/features/selection/select-matching-dialog";
import { usePreferenceEffects } from "@/features/settings/use-preference-effects";
import { Sidebar } from "@/features/sidebar/sidebar";
import { SyncDialog } from "@/features/sync/sync-dialog";
import { TerminalPanel } from "@/features/terminal/terminal-panel";
import { DiskUsageDialog } from "@/features/usage/disk-usage-dialog";
import { useLiveDirs } from "@/features/watch/use-live-dirs";
import { Workspace } from "@/features/workspace/workspace";
import { useApp } from "@/stores/app-store";

export function AppShell() {
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  // Helpers such as formatDate() read the language directly, so memoized parts
  // are rebuilt on a language switch. The terminal panel is left alone: its
  // shells must keep running.
  const language = useApp((s) => s.language);
  useLiveDirs();
  usePreferenceEffects();
  useExternalDrop();

  return (
    <div className="flex h-full">
      {sidebarVisible && <Sidebar key={language} />}
      <main className="flex min-w-0 flex-1 flex-col border-l border-border bg-bg">
        <Toolbar key={language} inset={!sidebarVisible} />
        <FdaBanner key={`fda-${language}`} />
        <Workspace key={`ws-${language}`} />
        <TerminalPanel />
      </main>
      <DragGhost />
      <ConflictDialog />
      <InfoDialog />
      <CommandPalette />
      <BatchRenameDialog />
      <SelectMatchingDialog />
      <CompareFilesDialog />
      <DuplicatesDialog />
      <SyncDialog />
      <WhatsNewDialog />
      <DiskUsageDialog />
    </div>
  );
}
