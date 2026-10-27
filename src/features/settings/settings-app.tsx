import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";
import { Keyboard, Palette, Settings2, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { events } from "@/bindings";
import { ShortcutsSection } from "@/features/settings/shortcuts-section";
import { applyTheme } from "@/features/settings/use-preference-effects";
import { copyText, cutText, focusedTextField, pasteText, undoText } from "@/lib/text-edit";
import { DEFAULT_PREFERENCES, type Preferences } from "@/stores/app-store";

const store = new LazyStore("settings.json");

/** One preference, read from and written to the store the main window watches. */
export function usePref<K extends keyof Preferences>(key: K): [Preferences[K], (v: Preferences[K]) => void] {
  const [value, setValue] = useState<Preferences[K]>(DEFAULT_PREFERENCES[key]);
  useEffect(() => {
    let live = true;
    void store.get<Preferences[K]>(key).then((v) => live && v !== undefined && setValue(v));
    const unlisten = store.onKeyChange<Preferences[K]>(key, (v) => setValue(v ?? DEFAULT_PREFERENCES[key]));
    return () => {
      live = false;
      void unlisten.then((fn) => fn());
    };
  }, [key]);
  const set = (v: Preferences[K]) => {
    setValue(v);
    void store.set(key, v);
  };
  return [value, set];
}

const SECTIONS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "advanced", label: "Advanced", icon: Wrench },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** The menu bar is shared: this window handles the few items that concern it. */
function useOwnMenuItems(): void {
  useEffect(() => {
    const unlisten = events.menuCommand.listen(({ payload }) => {
      if (!document.hasFocus()) return;
      const field = focusedTextField();
      switch (payload.id) {
        case "tab.close":
        case "window.close":
          void getCurrentWindow().close();
          break;
        case "edit.copy":
          if (field) void copyText(field);
          break;
        case "edit.cut":
          if (field) void cutText(field);
          break;
        case "edit.paste":
          if (field) void pasteText(field);
          break;
        case "edit.selectAll":
          field?.select();
          break;
        case "edit.undo":
        case "edit.redo":
          if (field) undoText(payload.id === "edit.redo");
          break;
      }
    });
    return () => void unlisten.then((fn) => fn());
  }, []);
}

export function SettingsApp() {
  const [section, setSection] = useState<SectionId>("general");
  const [theme] = usePref("theme");
  useEffect(() => applyTheme(theme), [theme]);
  useOwnMenuItems();

  return (
    <div className="flex h-full bg-bg text-[13px]">
      <nav
        aria-label="Settings sections"
        className="flex w-[170px] shrink-0 flex-col gap-px border-r border-border bg-bg-alt p-2"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-current={section === s.id ? "page" : undefined}
            onClick={() => setSection(s.id)}
            className={`flex h-7 items-center gap-2 rounded-md px-2 text-left ${
              section === s.id ? "bg-sidebar-active" : "hover:bg-hover"
            }`}
          >
            <s.icon className="size-4 text-accent" strokeWidth={1.75} />
            {s.label}
          </button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto p-5">
        {section === "general" && <GeneralSection />}
        {section === "appearance" && <AppearanceSection />}
        {section === "terminal" && <TerminalSection />}
        {section === "shortcuts" && <ShortcutsSection usePref={usePref} />}
        {section === "advanced" && <AdvancedSection />}
      </main>
    </div>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border py-3 last:border-0">
      <div>
        <p className="m-0">{label}</p>
        {hint && <p className="m-0 mt-0.5 text-[12px] text-fg-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-checked={value}
      aria-label={label}
      checked={value}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 accent-[var(--accent)]"
    />
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="h-7 rounded-md border border-border bg-bg px-2"
    >
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

function GeneralSection() {
  const [newTab, setNewTab] = usePref("newTabLocation");
  const [restore, setRestore] = usePref("restoreSession");
  const [hidden, setHidden] = usePref("showHidden");
  return (
    <section>
      <h1 className="m-0 mb-2 text-[17px] font-semibold">General</h1>
      <Row label="New tabs open" hint="Where ⌘T starts.">
        <Choice
          label="New tabs open"
          value={newTab}
          onChange={setNewTab}
          options={[
            ["current", "The current folder"],
            ["home", "Home"],
          ]}
        />
      </Row>
      <Row label="Restore tabs and layout at launch">
        <Toggle label="Restore tabs and layout at launch" value={restore} onChange={setRestore} />
      </Row>
      <Row label="Show hidden files" hint="Also ⇧⌘. in any folder.">
        <Toggle label="Show hidden files" value={hidden} onChange={setHidden} />
      </Row>
    </section>
  );
}

function AppearanceSection() {
  const [theme, setTheme] = usePref("theme");
  return (
    <section>
      <h1 className="m-0 mb-2 text-[17px] font-semibold">Appearance</h1>
      <Row label="Appearance" hint="System follows macOS light and dark mode.">
        <Choice
          label="Appearance"
          value={theme}
          onChange={setTheme}
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
        />
      </Row>
    </section>
  );
}

function TerminalSection() {
  const [size, setSize] = usePref("terminalFontSize");
  const [startIn, setStartIn] = usePref("terminalStartIn");
  return (
    <section>
      <h1 className="m-0 mb-2 text-[17px] font-semibold">Terminal</h1>
      <Row label="Font size">
        <input
          type="number"
          aria-label="Font size"
          min={9}
          max={24}
          value={size}
          onChange={(e) => setSize(Math.min(24, Math.max(9, Number(e.target.value) || 12)))}
          className="h-7 w-20 rounded-md border border-border bg-bg px-2"
        />
      </Row>
      <Row label="New terminals start in">
        <Choice
          label="New terminals start in"
          value={startIn}
          onChange={setStartIn}
          options={[
            ["pane", "The active pane’s folder"],
            ["home", "Home"],
          ]}
        />
      </Row>
      <p className="mt-3 text-[12px] text-fg-muted">
        The shell is your login shell ($SHELL) with your usual configuration. In zsh, the pane can follow `cd`
        (Link button in the terminal bar).
      </p>
    </section>
  );
}

function AdvancedSection() {
  const [done, setDone] = useState<string | null>(null);
  const action = (name: "resetLayout" | "clearRecents", message: string) => {
    void emitTo("main", "settings-action", { action: name }).then(() => setDone(message));
  };
  return (
    <section>
      <h1 className="m-0 mb-2 text-[17px] font-semibold">Advanced</h1>
      <Row
        label="Reset tabs and layout"
        hint="Closes all tabs and returns to a single pane on your Home folder."
      >
        <button
          type="button"
          onClick={() => action("resetLayout", "Tabs and layout were reset.")}
          className="h-7 rounded-md border border-border bg-bg px-3 hover:bg-hover"
        >
          Reset
        </button>
      </Row>
      <Row label="Clear recent folders" hint="Used by the command palette (⌘K).">
        <button
          type="button"
          onClick={() => action("clearRecents", "Recent folders were cleared.")}
          className="h-7 rounded-md border border-border bg-bg px-3 hover:bg-hover"
        >
          Clear
        </button>
      </Row>
      {done && (
        <p role="status" className="mt-3 text-[12px] text-fg-muted">
          {done}
        </p>
      )}
    </section>
  );
}
