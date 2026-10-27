import { CaseSensitive, Eye, Loader2, Regex, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SearchMode, SearchSpec } from "@/bindings";
import { navigateTo } from "@/commands/navigation";
import { basename } from "@/lib/path";
import { parseSearchPath, searchPath } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { EMPTY_SEARCH, useSearchInfo } from "@/stores/search-store";
import type { PaneId } from "@/stores/workspace-store";

const MODES: { mode: SearchMode; label: string; hint: string }[] = [
  { mode: "name", label: "Name", hint: "File and folder names; * and ? work as wildcards" },
  { mode: "content", label: "Contents", hint: "Text inside files (skips binaries and .gitignore’d files)" },
  { mode: "spotlight", label: "Spotlight", hint: "The Spotlight index: fast, includes kind:pdf and similar" },
];

/** Set right before re-running a search so the new header keeps keyboard focus. */
let keepFocus = false;

/** Query, options and progress above a search results tab. */
export function SearchHeader({ pane, path }: { pane: PaneId; path: string }) {
  const spec = parseSearchPath(path);
  const [query, setQuery] = useState(spec?.query ?? "");
  const info = useSearchInfo((s) => s.searches[path]) ?? EMPTY_SEARCH;
  const count = useDirCache((s) => s.dirs[path]?.entries.length ?? 0);
  const home = useApp((s) => s.home);
  const inputRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount only
  useEffect(() => {
    if (keepFocus || !spec?.query) inputRef.current?.focus();
    keepFocus = false;
  }, []);

  if (!spec) return null;
  const tag = spec.mode === "tag";

  const run = (patch: Partial<SearchSpec>) => {
    keepFocus = document.activeElement === inputRef.current;
    // Refining a search replaces it in the history instead of stacking up.
    navigateTo(searchPath({ ...spec, query, ...patch }), { pane, history: "replace" });
  };

  const scopes: { path: string; label: string }[] = [];
  const add = (p: string, label: string) => {
    if (!scopes.some((s) => s.path === p)) scopes.push({ path: p, label });
  };
  add(spec.scope, spec.scope === "/" ? "This Mac" : basename(spec.scope));
  add(home, "Home");
  add("/", "This Mac");

  return (
    <div data-search-header className="shrink-0 border-b border-border bg-toolbar px-2 py-1.5 text-[12px]">
      <div className="flex items-center gap-1.5">
        {!tag && (
          <fieldset aria-label="Search by" className="m-0 flex shrink-0 rounded-md border border-border p-px">
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                title={m.hint}
                aria-pressed={spec.mode === m.mode}
                onClick={() => run({ mode: m.mode })}
                className={`h-5 rounded-[5px] px-2 ${spec.mode === m.mode ? "bg-sidebar-active text-fg" : "text-fg-muted hover:text-fg"}`}
              >
                {m.label}
              </button>
            ))}
          </fieldset>
        )}
        <label className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-bg px-2 focus-within:ring-2 focus-within:ring-accent/40">
          <Search className="size-3.5 shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            data-search-query
            type="search"
            aria-label="Search"
            placeholder={spec.mode === "content" ? "Text in files" : "Search"}
            value={query}
            readOnly={tag}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                run({});
              } else if (e.key === "Escape" && info.running) {
                e.preventDefault();
                useDirCache.getState().stop(path);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                document.querySelector<HTMLElement>(`section[data-pane="${pane}"] [role="grid"]`)?.focus();
              }
            }}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg-faint"
          />
        </label>
        {!tag && (
          <>
            <Toggle
              label="Match Case"
              on={spec.caseSensitive}
              onClick={() => run({ caseSensitive: !spec.caseSensitive })}
            >
              <CaseSensitive className="size-4" />
            </Toggle>
            {spec.mode === "content" && (
              <Toggle label="Regular Expression" on={spec.regex} onClick={() => run({ regex: !spec.regex })}>
                <Regex className="size-3.5" />
              </Toggle>
            )}
            {spec.mode !== "spotlight" && (
              <Toggle
                label="Include Hidden Files"
                on={spec.includeHidden}
                onClick={() => run({ includeHidden: !spec.includeHidden })}
              >
                <Eye className="size-3.5" />
              </Toggle>
            )}
          </>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1 text-fg-muted">
        {!tag && (
          <>
            <span>Search in</span>
            {scopes.map((s) => (
              <button
                key={s.path}
                type="button"
                aria-pressed={spec.scope === s.path}
                onClick={() => run({ scope: s.path })}
                className={`h-[18px] rounded px-1.5 ${spec.scope === s.path ? "bg-sidebar-active text-fg" : "hover:bg-hover hover:text-fg"}`}
              >
                {s.label}
              </button>
            ))}
          </>
        )}
        <span className="ml-auto flex items-center gap-1.5 tabular-nums">
          <Status info={info} count={count} hasQuery={!!spec.query.trim()} />
          {info.running && (
            <button
              type="button"
              title="Stop (Esc)"
              aria-label="Stop searching"
              onClick={() => useDirCache.getState().stop(path)}
              className="flex size-4 items-center justify-center rounded-sm hover:bg-hover hover:text-fg"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

function Status({ info, count, hasQuery }: { info: typeof EMPTY_SEARCH; count: number; hasQuery: boolean }) {
  const n = count.toLocaleString();
  if (!hasQuery) return <span>Type and press Return</span>;
  if (info.running)
    return (
      <>
        <Loader2 className="size-3 animate-spin" />
        <span>
          {n} found{info.scanned > 0 ? ` · ${info.scanned.toLocaleString()} checked` : ""}
        </span>
      </>
    );
  const o = info.outcome;
  if (!o) return null;
  return (
    <span>
      {n} result{count === 1 ? "" : "s"}
      {o.truncated ? " (only the first ones are shown)" : o.cancelled ? " (stopped)" : ""}
    </span>
  );
}

function Toggle({
  label,
  on,
  onClick,
  children,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={`flex size-6 shrink-0 items-center justify-center rounded-md ${on ? "bg-sidebar-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"}`}
    >
      {children}
    </button>
  );
}
