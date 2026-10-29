import { Menu } from "@tauri-apps/api/menu";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns2,
  Columns3,
  LayoutGrid,
  List,
  PanelRight,
  Search,
} from "lucide-react";
import { goHistory } from "@/commands/navigation";
import { runCommand } from "@/commands/registry";
import { JobsIndicator } from "@/features/jobs/jobs-indicator";
import { PathBar } from "@/features/navigation/path-bar";
import { useT } from "@/i18n";
import { locationTitle } from "@/lib/location-title";
import { useApp } from "@/stores/app-store";
import { getActiveTab, useActiveTab, useWorkspace } from "@/stores/workspace-store";

/** Right-click on Back / Forward: the places in that direction, nearest first (like Finder). */
async function showHistoryMenu(direction: -1 | 1): Promise<void> {
  const { history } = getActiveTab();
  const { connections } = useApp.getState();
  const items = [];
  for (
    let i = history.index + direction, n = 1;
    i >= 0 && i < history.stack.length && n <= 20;
    i += direction, n++
  ) {
    const path = history.stack[i];
    if (path === undefined) break;
    const steps = n * direction;
    items.push({ text: locationTitle(path, connections), action: () => goHistory(steps) });
  }
  if (items.length === 0) return;
  const menu = await Menu.new({ items });
  await menu.popup();
}

/** Title-bar toolbar. `inset` leaves room for the traffic lights when the sidebar is hidden. */
export function Toolbar({ inset }: { inset: boolean }) {
  const { t } = useT();
  const tab = useActiveTab();
  const dual = useWorkspace((s) => s.dualPane);
  const preview = useWorkspace((s) => s.preview.visible);
  const canBack = tab.history.index > 0;
  const canForward = tab.history.index < tab.history.stack.length - 1;

  return (
    <header
      data-tauri-drag-region
      className={`flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-toolbar pr-3 ${
        inset ? "pl-[84px]" : "pl-2"
      }`}
    >
      <div className="flex items-center">
        <ToolButton
          label={t("Back")}
          disabled={!canBack}
          onClick={() => runCommand("nav.back")}
          onContextMenu={() => void showHistoryMenu(-1)}
        >
          <ChevronLeft className="size-5" />
        </ToolButton>
        <ToolButton
          label={t("Forward")}
          disabled={!canForward}
          onClick={() => runCommand("nav.forward")}
          onContextMenu={() => void showHistoryMenu(1)}
        >
          <ChevronRight className="size-5" />
        </ToolButton>
        <ToolButton
          label={t("Enclosing Folder")}
          disabled={tab.path === "/"}
          onClick={() => runCommand("nav.up")}
        >
          <ChevronUp className="size-5" />
        </ToolButton>
      </div>
      <PathBar path={tab.path} />
      <JobsIndicator />
      <fieldset aria-label={t("View")} className="m-0 flex items-center rounded-md border border-border p-px">
        {(
          [
            ["list", "as List", List, "view.asList"],
            ["icons", "as Icons", LayoutGrid, "view.asIcons"],
            ["columns", "as Columns", Columns3, "view.asColumns"],
          ] as const
        ).map(([mode, label, Icon, command]) => (
          <button
            key={mode}
            type="button"
            aria-pressed={tab.view.mode === mode}
            title={t(label)}
            aria-label={t(label)}
            onClick={() => runCommand(command)}
            className={`flex h-6 w-7 items-center justify-center rounded-[5px] ${
              tab.view.mode === mode ? "bg-sidebar-active text-fg" : "text-fg-muted hover:text-fg"
            }`}
          >
            <Icon className="size-4" />
          </button>
        ))}
      </fieldset>
      <div className="flex items-center">
        <ToolButton label={t("Dual Pane (⌘U)")} pressed={dual} onClick={() => runCommand("pane.toggleDual")}>
          <Columns2 className="size-4" />
        </ToolButton>
        <ToolButton
          label={t("Preview (⇧⌘P)")}
          pressed={preview}
          onClick={() => runCommand("view.togglePreview")}
        >
          <PanelRight className="size-4" />
        </ToolButton>
      </div>
      <label className="flex h-7 w-48 items-center gap-1.5 rounded-md border border-border bg-bg px-2 focus-within:ring-2 focus-within:ring-accent/40">
        <Search className="size-3.5 shrink-0 text-fg-muted" />
        <input
          type="search"
          placeholder={t("Filter")}
          title={t("Filter by name, or by patterns like *.jpg; *.png")}
          data-filter-input
          value={tab.view.filter}
          onChange={(e) => useWorkspace.getState().updateView({ filter: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape") useWorkspace.getState().updateView({ filter: "" });
          }}
          className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-fg-faint"
          spellCheck={false}
        />
      </label>
    </header>
  );
}

function ToolButton({
  label,
  disabled,
  pressed,
  onClick,
  onContextMenu,
  children,
}: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  onContextMenu?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu();
      }}
      className={`flex size-7 items-center justify-center rounded-md enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-35 ${
        pressed ? "bg-sidebar-active text-fg" : "text-fg-muted"
      }`}
    >
      {children}
    </button>
  );
}
