import { Menu } from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ChevronRight, HardDrive, Search, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { commands } from "@/bindings";
import { goToTypedPath, navigateTo } from "@/commands/navigation";
import { t, useT } from "@/i18n";
import { archivePath, parseArchivePath } from "@/lib/archive-path";
import { basename, parent, segments, tildify } from "@/lib/path";
import { parseRemotePath, remotePath } from "@/lib/remote-path";
import { isVirtualPath, parseSearchPath, searchTitle } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";
import { useWorkspace } from "@/stores/workspace-store";

/** Right-click on a path segment: that folder in a new tab or window, or its path. */
async function showSegmentMenu(path: string): Promise<void> {
  const local = !isVirtualPath(path);
  const menu = await Menu.new({
    items: [
      { text: t("Open in New Tab"), action: () => useWorkspace.getState().openTab(path) },
      ...(local
        ? [
            { text: t("Open in New Window"), action: () => void commands.openWindow(path) },
            { item: "Separator" as const },
            { text: t("Show in Finder"), action: () => void commands.revealInFinder(path) },
            { text: t("Copy Path"), action: () => void writeText(path) },
          ]
        : []),
    ],
  });
  await menu.popup();
}

/** Breadcrumb that turns into a text field on double-click or ⇧⌘G. */
export function PathBar({ path }: { path: string }) {
  useT();
  const editing = useApp((s) => s.editingPath);
  const home = useApp((s) => s.home);
  const connections = useApp((s) => s.connections);
  const rootName = useApp((s) => s.volumes.find((v) => v.isRoot)?.name ?? "Macintosh HD");

  const search = parseSearchPath(path);
  if (editing)
    return <PathInput initial={tildify(search?.scope ?? parseArchivePath(path)?.archive ?? path, home)} />;
  if (search)
    return (
      <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-[13px]">
        <Search className="size-3.5 shrink-0 text-fg-muted" />
        <span className="truncate font-semibold">{searchTitle(search)}</span>
      </div>
    );

  // Inside an archive: the folders up to the archive, the archive, then its folders.
  const archive = parseArchivePath(path);
  const remote = parseRemotePath(path);
  const parts = remote
    ? [
        { name: connections.find((c) => c.id === remote.id)?.name ?? remote.id, path: remotePath(remote.id) },
        ...remote.inner
          .split("/")
          .filter(Boolean)
          .map((name, i, all) => ({ name, path: remotePath(remote.id, all.slice(0, i + 1).join("/")) })),
      ]
    : archive
      ? [
          ...segments(parent(archive.archive) ?? "/"),
          { name: basename(archive.archive), path: archivePath(archive.archive) },
          ...archive.inner
            .split("/")
            .filter(Boolean)
            .map((name, i, all) => ({
              name,
              path: archivePath(archive.archive, all.slice(0, i + 1).join("/")),
            })),
        ]
      : segments(path);
  return (
    <div
      className="flex h-7 min-w-0 flex-1 items-center overflow-hidden rounded-md px-1"
      onDoubleClick={(e) => {
        if (e.target === e.currentTarget) useApp.getState().set({ editingPath: true });
      }}
    >
      {parts.map((seg, i) => {
        const last = i === parts.length - 1;
        return (
          <div key={seg.path} className={`flex items-center ${last ? "min-w-0" : "shrink"}`}>
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-fg-faint" />}
            <button
              type="button"
              onClick={(e) => {
                // ⌘-click opens the folder in a new tab, like a link.
                if (e.metaKey) useWorkspace.getState().openTab(seg.path);
                else if (!last) navigateTo(seg.path);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) useWorkspace.getState().openTab(seg.path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                void showSegmentMenu(seg.path);
              }}
              className={`flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-[13px] ${
                last ? "font-semibold" : "text-fg-muted hover:bg-hover hover:text-fg"
              }`}
            >
              {i === 0 &&
                (remote ? (
                  <Server className="size-3.5 shrink-0" />
                ) : (
                  <HardDrive className="size-3.5 shrink-0" />
                ))}
              <span className="truncate">{i === 0 && !remote ? rootName : seg.name}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Typed text split into the folder to look in and the name being typed (`~` kept as typed). */
function splitTyped(value: string, home: string): { dir: string; typedDir: string; prefix: string } | null {
  const slash = value.lastIndexOf("/");
  if (slash < 0) return null;
  const typedDir = value.slice(0, slash + 1);
  const dir = typedDir.startsWith("~") ? home + typedDir.slice(1) : typedDir;
  if (!dir.startsWith("/")) return null;
  return { dir: dir.length > 1 ? dir.replace(/\/+$/, "") : dir, typedDir, prefix: value.slice(slash + 1) };
}

function commonPrefix(names: readonly string[]): string {
  const [first = ""] = names;
  let n = first.length;
  for (const name of names) {
    while (n > 0 && name.slice(0, n).toLowerCase() !== first.slice(0, n).toLowerCase()) n--;
  }
  return first.slice(0, n);
}

function PathInput({ initial }: { initial: string }) {
  const { t } = useT();
  const home = useApp((s) => s.home);
  const [value, setValue] = useState(initial);
  const [suggestions, setSuggestions] = useState<{ typedDir: string; names: string[] } | null>(null);
  /** Suggestion picked with the arrow keys; -1 for none. */
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);
  const close = () => useApp.getState().set({ editingPath: false });

  useEffect(() => {
    ref.current?.select();
  }, []);

  /** Tab: completes a unique folder (adding "/"), or the shared start and lists the choices. */
  const complete = async () => {
    const parts = splitTyped(value, home);
    if (!parts) return;
    const r = await commands.completePath(parts.dir, parts.prefix);
    // Typing went on while the folder was read; don't overwrite it.
    if (ref.current?.value !== value) return;
    const names = r.status === "ok" ? r.data : [];
    const [only] = names;
    if (names.length === 1 && only) {
      setValue(`${parts.typedDir}${only}/`);
      setSuggestions(null);
    } else if (names.length > 1) {
      const shared = commonPrefix(names);
      if (shared.length > parts.prefix.length) setValue(parts.typedDir + shared);
      setSuggestions({ typedDir: parts.typedDir, names });
      setActive(-1);
    } else setSuggestions(null);
  };

  const pick = (typedDir: string, name: string) => {
    setValue(`${typedDir}${name}/`);
    setSuggestions(null);
  };

  const step = (delta: number) => {
    if (!suggestions) return;
    const n = suggestions.names.length;
    setActive((i) => (i < 0 ? (delta > 0 ? 0 : n - 1) : (i + delta + n) % n));
  };

  return (
    <div className="relative flex min-w-0 flex-1">
      <input
        ref={ref}
        aria-label={t("Go to folder")}
        aria-autocomplete="list"
        aria-controls={suggestions ? "path-suggestions" : undefined}
        aria-activedescendant={suggestions && active >= 0 ? `path-suggestion-${active}` : undefined}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSuggestions(null);
        }}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            if (suggestions) setSuggestions(null);
            else close();
          } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestions) {
            e.preventDefault();
            step(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            const chosen = active >= 0 ? suggestions?.names[active] : undefined;
            if (suggestions && chosen !== undefined) {
              pick(suggestions.typedDir, chosen);
              return;
            }
            void goToTypedPath(value).then((ok) => ok && close());
          } else if (e.key === "Tab" && !e.shiftKey) {
            e.preventDefault();
            void complete();
          }
        }}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-[12px] outline-none ring-2 ring-accent/40"
      />
      {suggestions && (
        <div
          id="path-suggestions"
          role="listbox"
          aria-label={t("Folders")}
          className="absolute top-8 left-0 z-50 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-bg py-1 font-mono text-[12px] shadow-lg"
        >
          {suggestions.names.map((name, i) => (
            <div
              key={name}
              tabIndex={-1}
              id={`path-suggestion-${i}`}
              role="option"
              aria-selected={i === active}
              ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
              // Keeps focus in the field (a blur would close it).
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(suggestions.typedDir, name)}
              onKeyDown={() => {}}
              className={`truncate px-2 py-0.5 ${i === active ? "bg-accent text-white" : "hover:bg-hover"}`}
            >
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
