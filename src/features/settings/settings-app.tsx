import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";
import { Keyboard, Palette, Settings2, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { events } from "@/bindings";
import { ShortcutsSection } from "@/features/settings/shortcuts-section";
import { applyLanguage, applyTheme } from "@/features/settings/use-preference-effects";
import { msg, useT } from "@/i18n";
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
  { id: "general", label: msg("General"), icon: Settings2 },
  { id: "appearance", label: msg("Appearance"), icon: Palette },
  { id: "terminal", label: msg("Terminal"), icon: SquareTerminal },
  { id: "shortcuts", label: msg("Shortcuts"), icon: Keyboard },
  { id: "advanced", label: msg("Advanced"), icon: Wrench },
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
  const { t } = useT();
  const [section, setSection] = useState<SectionId>("general");
  const [theme] = usePref("theme");
  const [languagePref] = usePref("languagePref");
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => void applyLanguage(languagePref), [languagePref]);
  useOwnMenuItems();

  return (
    <div className="flex h-full bg-bg text-[13px]">
      <nav
        aria-label={t("Settings sections")}
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
            {t(s.label)}
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
  const [gitStatus, setGitStatus] = usePref("showGitStatus");
  const { t } = useT();
  return (
    <section>
      <h1 className="m-0 mb-2 text-[17px] font-semibold">{t("General")}</h1>
      <Row label={t("New tabs open")} hint={t("Where ⌘T starts.")}>
        <Choice
          label={t("New tabs open")}
          value={newTab}
          onChange={setNewTab}
          options={[
            ["current", t("The current folder")],
            ["home", t("Home")],
          ]}
        />
      </Row>
      <Row label={t("Restore tabs and layout at launch")}>
        <Toggle label={t("Restore tabs and layout at launch")} value={restore} onChange={setRestore} />
      </Row>
      <Row label={t("Show hidden files")} hint={t("Also ⇧⌘. in any folder.")}>
        <Toggle label={t("Show hidden files")} value={hidden} onChange={setHidden} />
      </Row>
      <Row
        label={t("Show Git status")}
        hint={t("Badges for changed files and the branch in folders under Git.")}
      >
        <Toggle label={t("Show Git status")} value={gitStatus} onChange={setGitStatus} />
      </Row>
    </section>
  );
}

function AppearanceSection() {
  const [theme, setTheme] = usePref("theme");
  const [language, setLanguage] = usePref("languagePref");
  const { t } = useT();
  return (
    <section>
      <h1 className="m-0 mb-2 text-[17px] font-semibold">{t("Appearance")}</h1>
      <Row label={t("Appearance")} hint={t("System follows macOS light and dark mode.")}>
        <Choice
          label={t("Appearance")}
          value={theme}
          onChange={setTheme}
          options={[
            ["system", t("System")],
            ["light", t("Light")],
            ["dark", t("Dark")],
          ]}
        />
      </Row>
      <Row
        label={t("Language")}
        hint={t("System uses Turkish when macOS is set to Turkish, otherwise English.")}
      >
        <Choice
          label={t("Language")}
          value={language}
          onChange={setLanguage}
          options={[
            ["system", t("System")],
            // Language names are shown in their own language.
            ["en", "English"],
            ["tr", "Türkçe"],
          ]}
        />
      </Row>
    </section>
  );
}

function TerminalSection() {
  const [size, setSize] = usePref("terminalFontSize");
  const [startIn, setStartIn] = usePref("terminalStartIn");
  const { t } = useT();
  return (
    <section>
      <h1 className="m-0 mb-2 text-[17px] font-semibold">{t("Terminal")}</h1>
      <Row label={t("Font size")}>
        <input
          type="number"
          aria-label={t("Font size")}
          min={9}
          max={24}
          value={size}
          onChange={(e) => setSize(Math.min(24, Math.max(9, Number(e.target.value) || 12)))}
          className="h-7 w-20 rounded-md border border-border bg-bg px-2"
        />
      </Row>
      <Row label={t("New terminals start in")}>
        <Choice
          label={t("New terminals start in")}
          value={startIn}
          onChange={setStartIn}
          options={[
            ["pane", t("The active pane’s folder")],
            ["home", t("Home")],
          ]}
        />
      </Row>
      <p className="mt-3 text-[12px] text-fg-muted">
        {t(
          "The shell is your login shell ($SHELL) with your usual configuration. In zsh, the pane can follow `cd` (Link button in the terminal bar).",
        )}
      </p>
    </section>
  );
}

function AdvancedSection() {
  const { t } = useT();
  const [done, setDone] = useState<string | null>(null);
  const action = (name: "resetLayout" | "clearRecents", message: string) => {
    void emitTo("main", "settings-action", { action: name }).then(() => setDone(message));
  };
  return (
    <section>
      <h1 className="m-0 mb-2 text-[17px] font-semibold">{t("Advanced")}</h1>
      <Row
        label={t("Reset tabs and layout")}
        hint={t("Closes all tabs and returns to a single pane on your Home folder.")}
      >
        <button
          type="button"
          onClick={() => action("resetLayout", msg("Tabs and layout were reset."))}
          className="h-7 rounded-md border border-border bg-bg px-3 hover:bg-hover"
        >
          {t("Reset")}
        </button>
      </Row>
      <Row label={t("Clear recent folders")} hint={t("Used by the command palette (⌘K).")}>
        <button
          type="button"
          onClick={() => action("clearRecents", msg("Recent folders were cleared."))}
          className="h-7 rounded-md border border-border bg-bg px-3 hover:bg-hover"
        >
          {t("Clear")}
        </button>
      </Row>
      {done && (
        <p role="status" className="mt-3 text-[12px] text-fg-muted">
          {t(done)}
        </p>
      )}
    </section>
  );
}
