import { ChevronDown, FolderInput, Link2, Plus, SquareTerminal, X } from "lucide-react";
import { lazy, Suspense, useRef } from "react";
import { runCommand } from "@/commands/registry";
import { closeTerminal } from "@/commands/terminal-commands";
import { Splitter } from "@/features/workspace/splitter";
import { useT } from "@/i18n";
import { basename } from "@/lib/path";
import { useApp } from "@/stores/app-store";
import { useTerminals } from "@/stores/terminal-store";

// xterm and its renderer load with the first terminal, not at startup.
const TerminalView = lazy(() =>
  import("@/features/terminal/terminal-view").then((m) => ({ default: m.TerminalView })),
);

export const TERMINAL_LIMITS = { min: 120, default: 260 } as const;

/** Bottom panel: terminal tabs over the active session. Shells keep running while it's hidden. */
export function TerminalPanel() {
  const { t } = useT();
  const visible = useApp((s) => s.terminalVisible);
  const height = useApp((s) => s.terminalHeight);
  const sessions = useTerminals((s) => s.sessions);
  const activeId = useTerminals((s) => s.activeId);
  const active = sessions.find((s) => s.id === activeId);
  const rootRef = useRef<HTMLDivElement>(null);

  if (sessions.length === 0) return null;

  const onDrag = (y: number) => {
    const bottom = rootRef.current?.parentElement?.getBoundingClientRect().bottom ?? window.innerHeight;
    const max = window.innerHeight * 0.75;
    const next = Math.round(Math.min(max, Math.max(TERMINAL_LIMITS.min, bottom - y)));
    useApp.getState().setPreference("terminalHeight", next);
  };

  return (
    <div ref={rootRef} hidden={!visible} className="terminal-panel flex shrink-0 flex-col" style={{ height }}>
      <Splitter
        label={t("Resize terminal")}
        orientation="horizontal"
        value={(height / window.innerHeight) * 100}
        onDrag={onDrag}
        onReset={() => useApp.getState().setPreference("terminalHeight", TERMINAL_LIMITS.default)}
      />
      <div className="flex h-[26px] shrink-0 items-stretch border-b border-border bg-toolbar text-[12px]">
        <div role="tablist" aria-label={t("Terminals")} className="flex min-w-0 flex-1 items-stretch">
          {sessions.map((s) => (
            <div
              key={s.id}
              role="tab"
              tabIndex={-1}
              aria-selected={s.id === activeId}
              title={s.cwd}
              onMouseDown={(e) => {
                if (e.button === 1) closeTerminal(s.id);
                else if (e.button === 0) useTerminals.getState().activate(s.id);
              }}
              className={`group flex max-w-[200px] min-w-0 flex-1 basis-0 items-center gap-1.5 border-r border-border px-2 ${
                s.id === activeId ? "bg-bg text-fg" : "text-fg-muted hover:bg-hover"
              } ${s.exited ? "italic opacity-60" : ""}`}
            >
              <SquareTerminal className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{s.cwd === "/" ? "/" : basename(s.cwd)}</span>
              {s.linked && <Link2 aria-label={t("Linked to pane")} className="size-3 shrink-0 text-accent" />}
              <button
                type="button"
                aria-label={t("Close terminal")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeTerminal(s.id)}
                className="flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 hover:bg-hover"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
          <PanelButton label={t("New Terminal (⌃⇧`)")} onClick={() => runCommand("terminal.new")}>
            <Plus className="size-3.5" />
          </PanelButton>
        </div>
        <PanelButton
          label={t("Link: the active pane follows the shell’s directory")}
          pressed={!!active?.linked}
          disabled={!active}
          onClick={() => active && useTerminals.getState().update(active.id, { linked: !active.linked })}
        >
          <Link2 className="size-3.5" />
        </PanelButton>
        <PanelButton
          label={t("Go to the pane’s folder")}
          disabled={!active}
          onClick={() => runCommand("terminal.cdToPane")}
        >
          <FolderInput className="size-3.5" />
        </PanelButton>
        <PanelButton label={t("Hide Terminal (⌃`)")} onClick={() => runCommand("terminal.toggle")}>
          <ChevronDown className="size-3.5" />
        </PanelButton>
      </div>
      {sessions.map((s) => (
        <Suspense key={s.id} fallback={null}>
          <TerminalView session={s} active={visible && s.id === activeId} />
        </Suspense>
      ))}
    </div>
  );
}

function PanelButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
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
      className={`flex w-7 shrink-0 items-center justify-center enabled:hover:bg-hover disabled:opacity-35 ${
        pressed ? "text-accent" : "text-fg-muted"
      }`}
    >
      {children}
    </button>
  );
}
