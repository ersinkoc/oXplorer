import { DragGhost } from "@/features/dnd/drag-ghost";
import { useExternalDrop } from "@/features/dnd/use-external-drop";
import { InfoDialog } from "@/features/info/info-dialog";
import { ConflictDialog } from "@/features/jobs/conflict-dialog";
import { FdaBanner } from "@/features/layout/fda-banner";
import { Toolbar } from "@/features/navigation/toolbar";
import { CommandPalette } from "@/features/palette/command-palette";
import { BatchRenameDialog } from "@/features/rename/batch-rename-dialog";
import { usePreferenceEffects } from "@/features/settings/use-preference-effects";
import { Sidebar } from "@/features/sidebar/sidebar";
import { TerminalPanel } from "@/features/terminal/terminal-panel";
import { useLiveDirs } from "@/features/watch/use-live-dirs";
import { Workspace } from "@/features/workspace/workspace";
import { useApp } from "@/stores/app-store";

export function AppShell() {
  const sidebarVisible = useApp((s) => s.sidebarVisible);
  useLiveDirs();
  usePreferenceEffects();
  useExternalDrop();

  return (
    <div className="flex h-full">
      {sidebarVisible && <Sidebar />}
      <main className="flex min-w-0 flex-1 flex-col border-l border-border bg-bg">
        <Toolbar inset={!sidebarVisible} />
        <FdaBanner />
        <Workspace />
        <TerminalPanel />
      </main>
      <DragGhost />
      <ConflictDialog />
      <InfoDialog />
      <CommandPalette />
      <BatchRenameDialog />
    </div>
  );
}
