import { RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { commands, type MenuEntry } from "@/bindings";
import { useT } from "@/i18n";
import { acceleratorFromEvent, formatAccelerator, normalizeAccelerator } from "@/lib/accelerator";
import { describeError } from "@/lib/ipc";
import type { Preferences } from "@/stores/app-store";

type Overrides = Preferences["shortcuts"];
type UsePref = <K extends keyof Preferences>(key: K) => [Preferences[K], (v: Preferences[K]) => void];

/** The shortcut a menu item ends up with. */
function effective(item: MenuEntry, overrides: Overrides): string | null {
  return item.id in overrides ? (overrides[item.id] ?? null) : (item.defaultAccelerator ?? null);
}

/** Drops overrides that equal the default, so defaults can still change later. */
function compact(items: readonly MenuEntry[], overrides: Overrides): Overrides {
  const out: Overrides = {};
  for (const [id, accel] of Object.entries(overrides)) {
    const item = items.find((i) => i.id === id);
    if (item && accel !== item.defaultAccelerator) out[id] = accel;
  }
  return out;
}

/**
 * Menu shortcuts: click one, press the new keys. A shortcut already in use is
 * only taken over after confirming; the menu bar is rebuilt immediately.
 */
export function ShortcutsSection({ usePref }: { usePref: UsePref }) {
  const { t } = useT();
  const [items, setItems] = useState<MenuEntry[]>([]);
  const [overrides, setOverrides] = usePref("shortcuts");
  const [recording, setRecording] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ id: string; accel: string; other: MenuEntry } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void commands.menuItems().then(setItems);
  }, []);

  const save = async (next: Overrides) => {
    const compacted = compact(items, next);
    const r = await commands.setShortcuts(compacted);
    if (r.status === "error") {
      setError(describeError(r.error));
      return;
    }
    setError(null);
    setOverrides(compacted);
  };

  const assign = (id: string, accel: string) => {
    const other = items.find(
      (i) =>
        i.id !== id &&
        effective(i, overrides) &&
        normalizeAccelerator(effective(i, overrides) ?? "") === normalizeAccelerator(accel),
    );
    if (other) setConflict({ id, accel, other });
    else void save({ ...overrides, [id]: accel });
  };

  // While recording, the next shortcut-like key press is the new shortcut.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      const accel = acceleratorFromEvent(e);
      if (!accel) return;
      setRecording(null);
      assign(recording, accel);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const menus = [...new Set(items.map((i) => i.menu))];
  return (
    <section>
      <h1 className="m-0 mb-1 text-[17px] font-semibold">{t("Shortcuts")}</h1>
      <p className="m-0 mb-3 text-[12px] text-fg-muted">
        {t("Click a shortcut and press the new keys (⌘, ⌃ or ⌥ plus a key, or a function key). Esc cancels.")}
      </p>
      {error && (
        <p role="alert" className="mb-2 rounded-md bg-red-500/10 px-2 py-1.5 text-[12px] text-red-600">
          {error}
        </p>
      )}
      {conflict && (
        <div
          role="alert"
          className="mb-2 flex items-center gap-2 rounded-md bg-accent/10 px-2 py-1.5 text-[12px]"
        >
          <span className="flex-1">
            {t("{shortcut} is used by “{command}”. Move it here?", {
              shortcut: formatAccelerator(conflict.accel),
              command: t(conflict.other.title),
            })}
          </span>
          <button
            type="button"
            className="h-6 rounded-md bg-accent px-2 text-white"
            onClick={() => {
              void save({ ...overrides, [conflict.other.id]: null, [conflict.id]: conflict.accel });
              setConflict(null);
            }}
          >
            {t("Move")}
          </button>
          <button
            type="button"
            className="h-6 rounded-md border border-border px-2"
            onClick={() => setConflict(null)}
          >
            {t("Cancel")}
          </button>
        </div>
      )}
      {menus.map((menu) => (
        <div key={menu} className="mb-3">
          <h2 className="m-0 mb-1 text-[11px] font-semibold text-fg-faint uppercase">{t(menu)}</h2>
          <div className="rounded-md border border-border">
            {items
              .filter((i) => i.menu === menu)
              .map((item) => {
                const accel = effective(item, overrides);
                const custom = item.id in overrides;
                const isRecording = recording === item.id;
                return (
                  <div
                    key={item.id}
                    className="flex h-8 items-center gap-2 border-b border-border px-2 last:border-0"
                  >
                    <span className="min-w-0 flex-1 truncate">{t(item.title)}</span>
                    <button
                      type="button"
                      aria-label={t("Shortcut for {command}", { command: t(item.title) })}
                      onClick={() => setRecording(isRecording ? null : item.id)}
                      className={`h-6 min-w-[88px] rounded-md border px-2 text-center font-mono text-[12px] ${
                        isRecording ? "border-accent text-accent" : "border-border hover:bg-hover"
                      } ${custom ? "font-semibold" : ""}`}
                    >
                      {isRecording ? t("Type keys…") : accel ? formatAccelerator(accel) : "—"}
                    </button>
                    <button
                      type="button"
                      title={t("Remove shortcut")}
                      aria-label={t("Remove shortcut for {command}", { command: t(item.title) })}
                      disabled={!accel}
                      onClick={() => void save({ ...overrides, [item.id]: null })}
                      className="flex size-6 items-center justify-center rounded text-fg-muted enabled:hover:bg-hover disabled:opacity-30"
                    >
                      <X className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title={t("Restore default")}
                      aria-label={t("Restore default shortcut for {command}", { command: t(item.title) })}
                      disabled={!custom}
                      onClick={() => {
                        const { [item.id]: _, ...rest } = overrides;
                        void save(rest);
                      }}
                      className="flex size-6 items-center justify-center rounded text-fg-muted enabled:hover:bg-hover disabled:opacity-30"
                    >
                      <RotateCcw className="size-3.5" />
                    </button>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
    </section>
  );
}
