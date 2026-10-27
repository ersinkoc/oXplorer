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
  Server,
} from "lucide-react";
import { toast } from "sonner";
import { commands, type VolumeInfo } from "@/bindings";
import { navigateTo } from "@/commands/navigation";
import { useDrag } from "@/features/dnd/drag-store";
import { describeError } from "@/lib/ipc";
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

export function Sidebar() {
  const locations = useApp((s) => s.locations);
  const volumes = useApp((s) => s.volumes);
  const current = useActiveTab().path;

  return (
    <nav aria-label="Sidebar" className="flex w-[200px] shrink-0 flex-col">
      {/* Traffic lights sit over this strip; it doubles as a window drag handle. */}
      <div data-tauri-drag-region className="h-[52px] shrink-0" />
      <div className="flex-1 overflow-y-auto px-2.5 pb-3">
        <Section title="Favorites">
          {locations.map((l) => (
            <Item
              key={l.id}
              icon={LOCATION_ICONS[l.id] ?? Folder}
              label={l.name}
              active={current === l.path}
              dropDir={l.path}
              onClick={() => navigateTo(l.path)}
            />
          ))}
        </Section>
        <Section title="Locations">
          {volumes.map((v) => (
            <Item
              key={v.mountPoint}
              icon={v.isLocal ? HardDrive : Server}
              label={v.name}
              active={current === v.mountPoint}
              dropDir={v.isReadOnly ? undefined : v.mountPoint}
              onClick={() => navigateTo(v.mountPoint)}
              action={
                v.isRoot ? undefined : { label: `Eject ${v.name}`, icon: Eject, run: () => void eject(v) }
              }
            />
          ))}
        </Section>
      </div>
    </nav>
  );
}

async function eject(volume: VolumeInfo): Promise<void> {
  const home = useApp.getState().home;
  // Don't leave the pane pointing into a volume that's about to disappear.
  if (getActiveTab().path.startsWith(volume.mountPoint)) navigateTo(home);
  const res = await commands.ejectVolume(volume.mountPoint);
  if (res.status === "error") toast.error(`Couldn’t eject “${volume.name}”: ${describeError(res.error)}`);
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
  label,
  active,
  dropDir,
  onClick,
  action,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  dropDir?: string;
  onClick: () => void;
  action?: { label: string; icon: LucideIcon; run: () => void };
}) {
  const isDropTarget = useDrag((s) => !!dropDir && s.target === dropDir);
  return (
    <li className="group relative">
      <button
        type="button"
        data-drop-dir={dropDir}
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${
          active ? "bg-sidebar-active" : "hover:bg-hover"
        } ${isDropTarget ? "ring-2 ring-accent ring-inset" : ""}`}
      >
        <Icon className="size-4 shrink-0 text-accent" strokeWidth={1.75} />
        <span className="truncate">{label}</span>
      </button>
      {action && (
        <button
          type="button"
          title={action.label}
          aria-label={action.label}
          onClick={action.run}
          className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg"
        >
          <action.icon className="size-3.5" />
        </button>
      )}
    </li>
  );
}
