import {
  AppWindow,
  Download,
  Eject,
  FileText,
  Folder,
  HardDrive,
  House,
  Image,
  type LucideIcon,
  Monitor,
  Search,
  Server,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { commands, type FinderTag, type VolumeInfo } from "@/bindings";
import { navigateTo } from "@/commands/navigation";
import { useDrag } from "@/features/dnd/drag-store";
import { msg, t, useT } from "@/i18n";
import { TAG_COLORS } from "@/lib/icons";
import { describeError } from "@/lib/ipc";
import { locationTitle } from "@/lib/location-title";
import { isRemotePath, remotePath } from "@/lib/remote-path";
import { moveToGap } from "@/lib/reorder";
import { isSearchPath, isVirtualPath, searchPath } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";
import { getActiveTab, useActiveTab } from "@/stores/workspace-store";

const LOCATION_ICONS: Record<string, LucideIcon> = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  applications: AppWindow,
  pictures: Image,
};

/** Names of the standard locations (sent in English by Rust), translated where they're shown. */
export const LOCATION_NAMES: Record<string, string> = {
  home: msg("Home"),
  desktop: msg("Desktop"),
  documents: msg("Documents"),
  downloads: msg("Downloads"),
  applications: msg("Applications"),
  pictures: msg("Pictures"),
};

export function Sidebar() {
  const { t } = useT();
  const locations = useApp((s) => s.locations);
  const volumes = useApp((s) => s.volumes);
  const connections = useApp((s) => s.connections);
  const favorites = useApp((s) => s.favorites);
  const current = useActiveTab().path;
  // Dragging a favorite: its index and the gap it would drop into.
  const [drag, setDrag] = useState<{ from: number; gap: number | null } | null>(null);
  const suppressClick = useRef(false);

  const startFavoriteDrag = (e: React.MouseEvent, from: number) => {
    if (e.button !== 0) return;
    const startY = e.clientY;
    let gap: number | null = null;
    const move = (ev: MouseEvent) => {
      if (gap === null && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      gap = favoriteGapAt(ev.clientY);
      setDrag({ from, gap });
    };
    const up = () => {
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
      setDrag(null);
      if (gap === null) return;
      // The click that may follow this mouseup isn't a navigation.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      });
      const { favorites: list, setPreference } = useApp.getState();
      setPreference("favorites", moveToGap(list, from, gap));
    };
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  };
  const [tags, setTags] = useState<FinderTag[]>([]);
  useEffect(() => {
    void commands.favoriteTags().then(setTags);
  }, []);

  return (
    <nav aria-label={t("Sidebar")} className="flex w-[200px] shrink-0 flex-col">
      {/* Traffic lights sit over this strip; it doubles as a window drag handle. */}
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="flex-1 overflow-y-auto px-2.5 pb-3">
        <Section title={t("Favorites")}>
          {locations.map((l) => (
            <Item
              key={l.id}
              icon={LOCATION_ICONS[l.id] ?? Folder}
              label={t(LOCATION_NAMES[l.id] ?? l.name)}
              active={current === l.path}
              dropDir={l.path}
              onClick={() => navigateTo(l.path)}
            />
          ))}
          {favorites.map((path, index) => {
            const label = locationTitle(path, connections);
            return (
              <Item
                key={path}
                favoriteIndex={index}
                dragging={drag?.from === index && drag.gap !== null}
                dropLine={
                  drag?.gap === index
                    ? "before"
                    : drag?.gap === index + 1 && index === favorites.length - 1
                      ? "after"
                      : undefined
                }
                onMouseDown={(e) => startFavoriteDrag(e, index)}
                icon={isSearchPath(path) ? Search : isRemotePath(path) ? Server : Folder}
                label={label}
                title={path}
                active={current === path}
                dropDir={isVirtualPath(path) ? undefined : path}
                onClick={() => {
                  if (!suppressClick.current) navigateTo(path);
                }}
                action={{
                  label: t("Remove “{name}” from the sidebar", { name: label }),
                  icon: X,
                  onHover: true,
                  run: () => removeFavorite(path),
                }}
              />
            );
          })}
        </Section>
        <Section title={t("Locations")}>
          {volumes.map((v) => (
            <Item
              key={v.mountPoint}
              icon={v.isLocal ? HardDrive : Server}
              label={v.name}
              active={current === v.mountPoint}
              dropDir={v.isReadOnly ? undefined : v.mountPoint}
              onClick={() => navigateTo(v.mountPoint)}
              action={
                v.isRoot
                  ? undefined
                  : { label: t("Eject {name}", { name: v.name }), icon: Eject, run: () => void eject(v) }
              }
            />
          ))}
        </Section>
        {connections.length > 0 && (
          <Section title={t("Connections")}>
            {connections.map((c) => {
              const path = remotePath(c.id);
              return (
                <Item
                  key={c.id}
                  icon={Server}
                  label={c.name || c.host}
                  active={current.startsWith(path)}
                  dropDir={path}
                  onClick={() => navigateTo(path)}
                />
              );
            })}
          </Section>
        )}
        {tags.length > 0 && (
          <Section title={t("Tags")}>
            {tags.map((tag) => {
              const path = tagSearchPath(tag.name);
              return (
                <Item
                  key={tag.name}
                  leading={<TagDot color={tag.color} />}
                  label={tag.name}
                  active={current === path}
                  onClick={() => navigateTo(path)}
                />
              );
            })}
          </Section>
        )}
      </div>
    </nav>
  );
}

/** Everything on this Mac carrying a tag, found through Spotlight (like Finder). */
function tagSearchPath(name: string): string {
  return searchPath({
    scope: "/",
    query: name,
    mode: "tag",
    caseSensitive: false,
    regex: false,
    includeHidden: false,
  });
}

function TagDot({ color }: { color: number }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <span
        className="size-2.5 rounded-full ring-1 ring-fg-faint/40"
        style={{ background: TAG_COLORS[color] ?? "transparent" }}
      />
    </span>
  );
}

const DRAG_THRESHOLD = 4;

/** The gap between favorites nearest to `y` (0 = before the first). */
function favoriteGapAt(y: number): number {
  const items = [...document.querySelectorAll<HTMLElement>("[data-favorite-index]")];
  const index = items.findIndex((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  return index < 0 ? items.length : index;
}

function removeFavorite(path: string): void {
  const { favorites, setPreference } = useApp.getState();
  setPreference(
    "favorites",
    favorites.filter((p) => p !== path),
  );
}

async function eject(volume: VolumeInfo): Promise<void> {
  const home = useApp.getState().home;
  // Don't leave the pane pointing into a volume that's about to disappear.
  if (getActiveTab().path.startsWith(volume.mountPoint)) navigateTo(home);
  const res = await commands.ejectVolume(volume.mountPoint);
  if (res.status === "error")
    toast.error(
      t("Couldn’t eject “{name}”: {reason}", { name: volume.name, reason: describeError(res.error) }),
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <h2 className="px-2 pt-1 pb-1 text-[11px] font-semibold text-fg-faint">{title}</h2>
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}

function Item({
  icon: Icon,
  leading,
  label,
  title,
  active,
  dropDir,
  onClick,
  action,
  favoriteIndex,
  dragging,
  dropLine,
  onMouseDown,
}: {
  icon?: LucideIcon;
  /** Replaces the icon (tag color dots). */
  leading?: ReactNode;
  label: string;
  /** Tooltip (the full path of a user favorite). */
  title?: string;
  active: boolean;
  dropDir?: string;
  onClick: () => void;
  /** `onHover`: only shown while the pointer is over the item. */
  action?: { label: string; icon: LucideIcon; run: () => void; onHover?: boolean };
  /** User favorites can be dragged to reorder them. */
  favoriteIndex?: number;
  dragging?: boolean;
  dropLine?: "before" | "after";
  onMouseDown?: (e: React.MouseEvent) => void;
}) {
  const isDropTarget = useDrag((s) => !!dropDir && s.target === dropDir);
  return (
    <li
      data-favorite-index={favoriteIndex}
      className={`group relative ${dragging ? "opacity-50" : ""} ${
        dropLine === "before"
          ? "before:absolute before:inset-x-1 before:-top-px before:h-0.5 before:bg-accent before:content-['']"
          : dropLine === "after"
            ? "after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:bg-accent after:content-['']"
            : ""
      }`}
    >
      <button
        type="button"
        data-drop-dir={dropDir}
        onMouseDown={onMouseDown}
        title={title}
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${
          active ? "bg-sidebar-active" : "hover:bg-hover"
        } ${isDropTarget ? "ring-2 ring-accent ring-inset" : ""}`}
      >
        {leading ?? (Icon && <Icon className="size-4 shrink-0 text-accent" strokeWidth={1.75} />)}
        <span className="truncate">{label}</span>
      </button>
      {action && (
        <button
          type="button"
          title={action.label}
          aria-label={action.label}
          onClick={action.run}
          className={`absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg ${
            action.onHover ? "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" : ""
          }`}
        >
          <action.icon className="size-3.5" />
        </button>
      )}
    </li>
  );
}
