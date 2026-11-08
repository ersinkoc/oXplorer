import { useEffect, useRef, useState } from "react";
import { commitRename } from "@/commands/file-commands";
import { useT } from "@/i18n";
import type { FileEntry } from "@/lib/ipc";
import { useApp } from "@/stores/app-store";

/** Inline name editor. Selects the name without its extension, like Finder. */
export function RenameInput({ entry, className }: { entry: FileEntry; className?: string }) {
  const { t } = useT();
  const [value, setValue] = useState(entry.name);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  // For the unmount below; a watcher update can replace `entry` mid-edit.
  const latest = useRef({ entry, value });
  const start = useRef({ name: entry.name, isDir: entry.kind === "dir" });

  useEffect(() => {
    latest.current.entry = entry;
  }, [entry]);

  // Select once: a later `entry` object (watcher update, reload) must not
  // reselect the name while the user types.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const { name, isDir } = start.current;
    const dot = isDir ? -1 : name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, []);

  // Clicking the other pane or a tab, or ⌘[ removes the field before it blurs:
  // keep the typed name, as Finder does when you click elsewhere.
  useEffect(() => {
    const el = ref.current;
    return () => {
      // StrictMode's trial unmount keeps the element; a real one removes it.
      setTimeout(() => {
        if (settled.current || el?.isConnected) return;
        settled.current = true;
        const { entry: edited, value: typed } = latest.current;
        if (useApp.getState().renaming === edited.path) useApp.getState().set({ renaming: null });
        void commitRename(edited, typed);
      }, 0);
    };
  }, []);

  const close = () => {
    settled.current = true;
    useApp.getState().set({ renaming: null });
  };
  const commit = async () => {
    if (settled.current) return;
    settled.current = true;
    if (await commitRename(entry, value)) close();
    else {
      // Keep editing so the user can fix the name.
      settled.current = false;
      ref.current?.focus();
    }
  };

  return (
    <input
      ref={ref}
      aria-label={t("Rename {name}", { name: entry.name })}
      value={value}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      onChange={(e) => {
        setValue(e.target.value);
        latest.current.value = e.target.value;
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
      onBlur={() => void commit()}
      className={`${className ?? ""} min-w-0 rounded-[3px] bg-bg px-1 text-fg outline-none ring-2 ring-accent`}
    />
  );
}
