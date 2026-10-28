import { Channel } from "@tauri-apps/api/core";
import { ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { commands, type UsageEvent_Deserialize, type UsageEvent_Serialize, type UsageNode } from "@/bindings";
import { navigateTo } from "@/commands/navigation";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";
import { formatSize } from "@/lib/format";
import { describeError, toAppError } from "@/lib/ipc";
import { basename, join } from "@/lib/path";
import { type Rect, squarify } from "@/lib/treemap";
import { useApp } from "@/stores/app-store";

/** View → Disk Usage: a treemap of what takes space under a folder. */
export function DiskUsageDialog() {
  const root = useApp((s) => s.diskUsagePath);
  const close = () => useApp.getState().set({ diskUsagePath: null });
  return (
    <Dialog open={!!root} onClose={close} label="Disk Usage" className="h-[78vh] w-[86vw] max-w-[1200px]">
      {root && <Body key={root} root={root} onClose={close} />}
    </Dialog>
  );
}

type Scan =
  | { status: "scanning"; bytes: number; files: number }
  | { status: "done"; node: UsageNode }
  | { status: "error"; message: string };

/** Scans `path` unless an earlier scan in this dialog already covered it. */
function useScan(path: string, cached: UsageNode | undefined, onDone: (node: UsageNode) => void): Scan {
  const [scan, setScan] = useState<Scan>({ status: "scanning", bytes: 0, files: 0 });
  // biome-ignore lint/correctness/useExhaustiveDependencies: rescans only when the folder changes
  useEffect(() => {
    if (cached) {
      setScan({ status: "done", node: cached });
      return;
    }
    const id = crypto.randomUUID();
    let live = true;
    setScan({ status: "scanning", bytes: 0, files: 0 });
    const channel = new Channel<UsageEvent_Deserialize>();
    channel.onmessage = (raw) => {
      if (!live) return;
      const ev = raw as UsageEvent_Serialize;
      if (ev.type === "progress") setScan({ status: "scanning", bytes: ev.bytes, files: ev.files });
      else if (ev.root) {
        setScan({ status: "done", node: ev.root });
        onDone(ev.root);
      }
    };
    void commands.diskUsage(id, path, channel).then((r) => {
      if (live && r.status === "error")
        setScan({ status: "error", message: describeError(toAppError(r.error)) });
    });
    return () => {
      live = false;
      void commands.diskUsageCancel(id);
    };
  }, [path]);
  return scan;
}

function Body({ root, onClose }: { root: string; onClose: () => void }) {
  const { t } = useT();
  // `base` is the folder whose scan is shown; `trail` the folders opened inside that scan.
  const [base, setBase] = useState(root);
  const [trail, setTrail] = useState<string[]>([]);
  const [cache] = useState(() => new Map<string, UsageNode>());
  const scan = useScan(base, cache.get(base), (node) => cache.set(base, node));

  let node: UsageNode | null = scan.status === "done" ? scan.node : null;
  for (const name of trail) node = node?.children.find((c) => c.name === name) ?? node;
  const path = trail.reduce((p, name) => join(p, name), base);

  // Breadcrumb from the dialog's folder down to the one shown.
  const below = path === root ? [] : path.slice(root.length).split("/").filter(Boolean);
  const crumbs = [basename(root) || "/", ...below];
  const baseDepth = base === root ? 0 : base.slice(root.length).split("/").filter(Boolean).length;

  const open = (child: UsageNode) => {
    if (!child.isDir || child.isOther) return;
    if (child.truncated) {
      // Below the depth that was sent: that folder gets its own scan.
      setBase(join(path, child.name));
      setTrail([]);
    } else setTrail((tr) => [...tr, child.name]);
  };

  const goTo = (depth: number) => {
    if (depth >= baseDepth) {
      setTrail(below.slice(baseDepth, depth));
      return;
    }
    // Above the current scan: use (or make) a scan of that folder.
    setBase(below.slice(0, depth).reduce((p, name) => join(p, name), root));
    setTrail([]);
  };

  return (
    <div className="flex h-full flex-col p-3 text-[13px]">
      <div className="mb-2 flex items-center gap-1 overflow-hidden">
        {crumbs.map((name, i) => (
          <span key={crumbs.slice(0, i + 1).join("/")} className="flex min-w-0 items-center">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-fg-faint" />}
            <button
              type="button"
              onClick={() => goTo(i)}
              className={`truncate rounded px-1 ${i === crumbs.length - 1 ? "font-semibold" : "text-fg-muted hover:bg-hover"}`}
            >
              {name}
            </button>
          </span>
        ))}
        {node && (
          <span className="ml-auto shrink-0 pl-3 text-fg-muted tabular-nums">{formatSize(node.size)}</span>
        )}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-bg-alt">
        {scan.status === "scanning" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-fg-muted">
            <Loader2 className="size-5 animate-spin" />
            <span className="tabular-nums">
              {t("{files} files, {size}", {
                files: scan.files.toLocaleString(),
                size: formatSize(scan.bytes),
              })}
            </span>
          </div>
        )}
        {scan.status === "error" && <p className="m-4 text-red-500">{scan.message}</p>}
        {node && (
          <Treemap
            node={node}
            onOpen={open}
            onReveal={(child) => {
              onClose();
              const target = join(path, child.name);
              if (child.isDir) navigateTo(target);
              else void commands.revealInFinder(target);
            }}
          />
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-[12px] text-fg-muted">
        <span>{t("Click a folder to look inside; double-click to open it in the pane.")}</span>
        <DialogButton onClick={onClose}>{t("Done")}</DialogButton>
      </div>
    </div>
  );
}

const PALETTE = [210, 28, 140, 280, 350, 180, 50, 100, 250, 0];

function Treemap({
  node,
  onOpen,
  onReveal,
}: {
  node: UsageNode;
  onOpen: (child: UsageNode) => void;
  onReveal: (child: UsageNode) => void;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [hover, setHover] = useState<{ node: UsageNode; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (e) setBox({ x: 0, y: 0, w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cells = squarify(
    node.children.map((c) => ({ value: c.size, item: c })),
    box,
  );

  return (
    <div ref={ref} className="absolute inset-0" onMouseLeave={() => setHover(null)}>
      <svg width={box.w} height={box.h} role="img" aria-label={t("Disk usage treemap")}>
        {cells.map(({ rect, item }, i) => {
          const hue = PALETTE[i % PALETTE.length] ?? 210;
          const fill = item.isOther
            ? "hsl(0 0% 60% / 0.35)"
            : item.isDir
              ? `hsl(${hue} 55% 55% / 0.55)`
              : `hsl(${hue} 20% 60% / 0.4)`;
          // Second level: a folder's own largest items, drawn inside it.
          const inner =
            item.isDir && rect.w > 60 && rect.h > 44
              ? squarify(
                  item.children.map((c) => ({ value: c.size, item: c })),
                  { x: rect.x + 3, y: rect.y + 18, w: rect.w - 6, h: rect.h - 21 },
                )
              : [];
          return (
            <g
              key={item.name}
              onMouseMove={(e) =>
                setHover({ node: item, x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY })
              }
              onClick={() => onOpen(item)}
              onDoubleClick={() => !item.isOther && onReveal(item)}
              style={{ cursor: item.isDir && !item.isOther ? "pointer" : "default" }}
            >
              <rect
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={rect.h}
                fill={fill}
                stroke="var(--bg)"
                strokeWidth={1.5}
                rx={3}
              />
              {inner.map((c) => (
                <rect
                  key={c.item.name}
                  x={c.rect.x}
                  y={c.rect.y}
                  width={c.rect.w}
                  height={c.rect.h}
                  fill={`hsl(${hue} 45% 50% / 0.35)`}
                  stroke="var(--bg)"
                  strokeWidth={0.75}
                  rx={2}
                />
              ))}
              {rect.w > 50 && rect.h > 16 && (
                <text
                  x={rect.x + 5}
                  y={rect.y + 13}
                  fontSize={11}
                  fill="var(--fg)"
                  style={{ pointerEvents: "none" }}
                >
                  {clip(
                    `${item.isOther ? t("{count} more items", { count: item.name.split(" ")[0] ?? "" }) : item.name} · ${formatSize(item.size)}`,
                    rect.w - 10,
                  )}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-bg px-2 py-1 text-[12px] shadow-lg"
          style={{ left: Math.min(hover.x + 12, box.w - 220), top: Math.min(hover.y + 12, box.h - 60) }}
        >
          <p className="m-0 font-semibold">{hover.node.isOther ? t("Other items") : hover.node.name}</p>
          <p className="m-0 text-fg-muted">
            {formatSize(hover.node.size)}
            {node.size > 0 && ` · ${((hover.node.size / node.size) * 100).toFixed(1)}%`}
            {hover.node.isDir && ` · ${t("{files} files", { files: hover.node.files.toLocaleString() })}`}
          </p>
        </div>
      )}
    </div>
  );
}

/** Truncates a label to roughly fit `width` px at 11px font. */
function clip(text: string, width: number): string {
  const max = Math.floor(width / 6.2);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
