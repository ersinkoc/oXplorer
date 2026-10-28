import { Menu } from "@tauri-apps/api/menu";
import { Pin, Plus, Search, Server, X } from "lucide-react";
import { useRef, useState } from "react";
import { closeTab } from "@/commands/tab-commands";
import { useT } from "@/i18n";
import { archiveTitle, parseArchivePath } from "@/lib/archive-path";
import { pathIconUrl } from "@/lib/icons";
import { basename } from "@/lib/path";
import { isRemotePath, remoteTitle } from "@/lib/remote-path";
import { parseSearchPath, searchTitle } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";
import { otherPane, type PaneId, type TabState, useWorkspace } from "@/stores/workspace-store";

const DRAG_THRESHOLD = 4;

interface DropSlot {
  pane: PaneId;
  index: number;
}

/** Where a dragged tab would land: the gap nearest the pointer in either pane's tab bar. */
function slotAt(x: number, y: number): DropSlot | null {
  const bar = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-tab-bar]");
  const pane = bar?.dataset.tabBar as PaneId | undefined;
  if (!bar || !pane) return null;
  const tabs = [...bar.querySelectorAll<HTMLElement>("[data-tab-id]")];
  const index = tabs.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return x < r.left + r.width / 2;
  });
  return { pane, index: index < 0 ? tabs.length : index };
}

export function TabBar({ pane }: { pane: PaneId }) {
  const { t } = useT();
  const tabs = useWorkspace((s) => s.panes[pane].tabs);
  const activeId = useWorkspace((s) => s.panes[pane].activeTabId);
  const paneActive = useWorkspace((s) => s.dualPane && s.activePane === pane);
  const [dragging, setDragging] = useState<string | null>(null);
  const [slot, setSlot] = useState<DropSlot | null>(null);
  const suppressClick = useRef(false);

  const onTabMouseDown = (e: React.MouseEvent, tab: TabState) => {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(pane, tab.id);
      return;
    }
    if (e.button !== 0) return;
    useWorkspace.getState().activateTab(pane, tab.id);
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    let target: DropSlot | null = null;
    const move = (ev: MouseEvent) => {
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      active = true;
      setDragging(tab.id);
      target = slotAt(ev.clientX, ev.clientY);
      setSlot(target);
    };
    const up = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      setDragging(null);
      setSlot(null);
      if (!active) return;
      suppressClick.current = true;
      if (target) useWorkspace.getState().moveTab(pane, tab.id, target.pane, target.index);
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  };

  const onContextMenu = async (e: React.MouseEvent, tab: TabState) => {
    e.preventDefault();
    const ws = useWorkspace.getState();
    const index = tabs.findIndex((other) => other.id === tab.id);
    const menu = await Menu.new({
      items: [
        { text: t("New Tab"), action: () => ws.openTab(tab.path, { pane }) },
        { item: "Separator" },
        { text: t("Close Tab"), action: () => closeTab(pane, tab.id) },
        {
          text: t("Close Other Tabs"),
          enabled: tabs.some((other) => other.id !== tab.id && !other.pinned),
          action: () => ws.closeOtherTabs(pane, tab.id),
        },
        {
          text: t("Close Tabs to the Right"),
          enabled: tabs.slice(index + 1).some((other) => !other.pinned),
          action: () => ws.closeTabsToRight(pane, tab.id),
        },
        { item: "Separator" },
        { text: tab.pinned ? t("Unpin Tab") : t("Pin Tab"), action: () => ws.togglePin(pane, tab.id) },
        {
          text: pane === "left" ? t("Move to Right Pane") : t("Move to Left Pane"),
          action: () => {
            const to = otherPane(pane);
            ws.moveTab(pane, tab.id, to, ws.panes[to].tabs.length);
          },
        },
      ],
    });
    await menu.popup();
  };

  return (
    <div
      data-tab-bar={pane}
      role="tablist"
      aria-label={pane === "left" ? t("Left pane tabs") : t("Right pane tabs")}
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget)
          useWorkspace.getState().openTab(tabs.find((x) => x.id === activeId)?.path ?? "/", { pane });
      }}
      className={`relative flex h-[28px] shrink-0 items-stretch border-b border-border bg-toolbar ${
        paneActive
          ? "after:absolute after:inset-x-0 after:top-0 after:h-[2px] after:bg-accent after:content-['']"
          : ""
      }`}
    >
      {tabs.map((tab, i) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          dragging={dragging === tab.id}
          dropBefore={slot?.pane === pane && slot.index === i}
          onMouseDown={(e) => onTabMouseDown(e, tab)}
          onContextMenu={(e) => void onContextMenu(e, tab)}
          onClose={() => closeTab(pane, tab.id)}
        />
      ))}
      {slot?.pane === pane && slot.index === tabs.length && <span className="w-0.5 bg-accent" />}
      <button
        type="button"
        title={t("New Tab")}
        aria-label={t("New Tab")}
        onClick={() =>
          useWorkspace.getState().openTab(tabs.find((x) => x.id === activeId)?.path ?? "/", { pane })
        }
        className="flex w-7 shrink-0 items-center justify-center text-fg-muted hover:bg-hover hover:text-fg"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function TabButton({
  tab,
  active,
  dragging,
  dropBefore,
  onMouseDown,
  onContextMenu,
  onClose,
}: {
  tab: TabState;
  active: boolean;
  dragging: boolean;
  dropBefore: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClose: () => void;
}) {
  const { t } = useT();
  const search = parseSearchPath(tab.path);
  const archive = parseArchivePath(tab.path);
  const remote = isRemotePath(tab.path);
  const connections = useApp((s) => s.connections);
  const name = search
    ? searchTitle(search)
    : archive
      ? archiveTitle(tab.path)
      : remote
        ? remoteTitle(tab.path, connections)
        : tab.path === "/"
          ? "Macintosh HD"
          : basename(tab.path);
  return (
    <div
      data-tab-id={tab.id}
      data-drop-dir={search || archive ? undefined : tab.path}
      role="tab"
      tabIndex={-1}
      aria-selected={active}
      title={search ? name : tab.path}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      className={`group relative flex min-w-0 items-center gap-1.5 border-r border-border px-2 text-[12px] ${
        tab.pinned ? "w-9 shrink-0 justify-center" : "max-w-[220px] flex-1 basis-0"
      } ${active ? "bg-bg text-fg" : "text-fg-muted hover:bg-hover"} ${dragging ? "opacity-50" : ""} ${
        dropBefore
          ? "before:absolute before:inset-y-0 before:-left-px before:w-0.5 before:bg-accent before:content-['']"
          : ""
      }`}
    >
      {search ? (
        <Search aria-hidden className="size-3.5 shrink-0" />
      ) : remote ? (
        <Server aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <img
          src={pathIconUrl(archive ? archive.archive : tab.path, 32)}
          alt=""
          aria-hidden
          draggable={false}
          className="size-4 shrink-0"
        />
      )}
      {tab.pinned ? (
        <Pin aria-label={t("Pinned")} className="absolute right-0.5 bottom-0.5 size-2 text-fg-muted" />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <button
            type="button"
            aria-label={t("Close {name}", { name })}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
            className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 hover:bg-hover"
          >
            <X className="size-3" />
          </button>
        </>
      )}
    </div>
  );
}
