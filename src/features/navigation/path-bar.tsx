import { ChevronRight, HardDrive, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { goToTypedPath, navigateTo } from "@/commands/navigation";
import { segments, tildify } from "@/lib/path";
import { parseSearchPath, searchTitle } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";

/** Breadcrumb that turns into a text field on double-click or ⇧⌘G. */
export function PathBar({ path }: { path: string }) {
  const editing = useApp((s) => s.editingPath);
  const home = useApp((s) => s.home);
  const rootName = useApp((s) => s.volumes.find((v) => v.isRoot)?.name ?? "Macintosh HD");

  const search = parseSearchPath(path);
  if (editing) return <PathInput initial={tildify(search?.scope ?? path, home)} />;
  if (search)
    return (
      <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 px-2 text-[13px]">
        <Search className="size-3.5 shrink-0 text-fg-muted" />
        <span className="truncate font-semibold">{searchTitle(search)}</span>
      </div>
    );

  const parts = segments(path);
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
              onClick={() => !last && navigateTo(seg.path)}
              className={`flex min-w-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-[13px] ${
                last ? "font-semibold" : "text-fg-muted hover:bg-hover hover:text-fg"
              }`}
            >
              {i === 0 && <HardDrive className="size-3.5 shrink-0" />}
              <span className="truncate">{i === 0 ? rootName : seg.name}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function PathInput({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const close = () => useApp.getState().set({ editingPath: false });

  useEffect(() => {
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      aria-label="Go to folder"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        } else if (e.key === "Enter") {
          e.preventDefault();
          void goToTypedPath(value).then((ok) => ok && close());
        }
      }}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 font-mono text-[12px] outline-none ring-2 ring-accent/40"
    />
  );
}
