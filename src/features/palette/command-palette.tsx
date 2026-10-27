import { Folder, HardDrive, Search, SquareChevronRight, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { goToTypedPath, navigateTo } from "@/commands/navigation";
import { listCommands, runCommand } from "@/commands/registry";
import { Dialog } from "@/features/ui/dialog";
import { fuzzyScore } from "@/lib/fuzzy";
import { basename, tildify } from "@/lib/path";
import { useApp } from "@/stores/app-store";
import { rankedVisits } from "@/stores/recents-store";

interface PaletteItem {
  key: string;
  kind: "command" | "folder" | "favorite" | "volume" | "path";
  title: string;
  subtitle?: string;
  /** Text matched against the query. */
  match: string;
  run: () => void;
}

const MAX_ITEMS = 50;
/** Internal or positional commands that make no sense to pick from a list. */
const HIDDEN_COMMANDS = /^(tab\.goto\.|palette\.)/;

function allItems(): PaletteItem[] {
  const { home, locations, volumes } = useApp.getState();
  const items: PaletteItem[] = [];
  const seen = new Set<string>();
  const folder = (path: string, kind: PaletteItem["kind"], title = basename(path) || path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const subtitle = tildify(path, home);
    items.push({
      key: `${kind}:${path}`,
      kind,
      title,
      subtitle,
      match: `${title} ${subtitle}`,
      run: () => navigateTo(path),
    });
  };
  for (const v of rankedVisits()) folder(v.path, "folder");
  for (const l of locations) folder(l.path, "favorite", l.name);
  for (const v of volumes) folder(v.mountPoint, "volume", v.name);
  for (const c of listCommands()) {
    if (HIDDEN_COMMANDS.test(c.id)) continue;
    items.push({
      key: `cmd:${c.id}`,
      kind: "command",
      title: c.title,
      match: c.title,
      run: () => runCommand(c.id),
    });
  }
  return items;
}

/** Ranks items for `query`; with no query, recent folders come first, then commands. */
function search(query: string, items: readonly PaletteItem[]): PaletteItem[] {
  const q = query.trim();
  const out: PaletteItem[] = [];
  if (q.startsWith("/") || q.startsWith("~")) {
    out.push({
      key: "path",
      kind: "path",
      title: `Go to “${q}”`,
      match: q,
      run: () => void goToTypedPath(q),
    });
  }
  if (!q) return [...out, ...items].slice(0, MAX_ITEMS);
  const scored = items
    .map((item) => {
      // A folder's own name counts more than its parent path.
      const name = fuzzyScore(q, item.title);
      const full = fuzzyScore(q, item.match);
      const score = name !== null ? name + 5 : full;
      return score === null ? null : { item, score };
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item);
  return [...out, ...scored].slice(0, MAX_ITEMS);
}

const ICONS = {
  command: SquareChevronRight,
  folder: Folder,
  favorite: Star,
  volume: HardDrive,
  path: Search,
};

/** ⌘K: one list for commands, frequently used folders and favorites. */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const close = () => useApp.getState().set({ paletteOpen: false });
  return (
    <Dialog
      open={open}
      onClose={close}
      label="Command palette"
      className="mt-[12vh] mb-auto w-[560px] max-w-[90vw]"
    >
      <PaletteBody onClose={close} />
    </Dialog>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const [items] = useState(allItems);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = search(query, items);
  const selected = results[Math.min(index, results.length - 1)];

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  });

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    // Let the dialog close (and focus return) before the action moves focus.
    requestAnimationFrame(item.run);
  };

  return (
    <div className="flex max-h-[60vh] flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 shrink-0 text-fg-muted" />
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
          autoFocus
          aria-label="Command or folder"
          aria-controls="palette-results"
          aria-activedescendant={selected ? `palette-${selected.key}` : undefined}
          placeholder="Type a command or folder name…"
          value={query}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const n = results.length;
              if (n > 0) setIndex((i) => (Math.min(i, n - 1) + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(selected);
            }
          }}
          className="h-11 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-fg-faint"
        />
      </div>
      <div
        id="palette-results"
        ref={listRef}
        role="listbox"
        aria-label="Results"
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {results.length === 0 && (
          <p className="m-0 px-3 py-6 text-center text-[13px] text-fg-muted">No matches</p>
        )}
        {results.map((item) => {
          const Icon = ICONS[item.kind];
          const isSelected = item === selected;
          return (
            <div
              key={item.key}
              tabIndex={-1}
              id={`palette-${item.key}`}
              role="option"
              aria-selected={isSelected}
              onMouseMove={() => setIndex(results.indexOf(item))}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(item)}
              onKeyDown={() => {}}
              className={`flex h-8 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] ${
                isSelected ? "bg-accent text-white" : ""
              }`}
            >
              <Icon className={`size-4 shrink-0 ${isSelected ? "" : "text-fg-muted"}`} />
              <span className="shrink-0 truncate">{item.title}</span>
              {item.subtitle && (
                <span
                  className={`min-w-0 truncate text-[12px] ${isSelected ? "text-white/75" : "text-fg-faint"}`}
                >
                  {item.subtitle}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
