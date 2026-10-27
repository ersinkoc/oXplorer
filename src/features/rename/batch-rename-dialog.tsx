import { useState } from "react";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { applyFsChanges, recordUndo } from "@/commands/jobs";
import { findPattern, previewRenames, type RenameRule } from "@/features/rename/batch-rules";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { isFolderLike } from "@/lib/format";
import { CommandError, type FileEntry, unwrap } from "@/lib/ipc";
import { parent } from "@/lib/path";
import { useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";

const PREVIEW_ROWS = 200;

/** "Rename N Items…" — Finder's three modes with a live preview. */
export function BatchRenameDialog() {
  const entries = useApp((s) => s.batchRename);
  const close = () => useApp.getState().set({ batchRename: null });
  return (
    <Dialog open={!!entries} onClose={close} label="Rename items" className="w-[560px]">
      {entries && <Body entries={entries} onClose={close} />}
    </Dialog>
  );
}

const input =
  "h-7 min-w-0 rounded-md border border-border bg-bg px-2 text-[13px] outline-none focus:ring-2 focus:ring-accent/40";

function Body({ entries, onClose }: { entries: FileEntry[]; onClose: () => void }) {
  const [kind, setKind] = useState<RenameRule["kind"]>("replace");
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [text, setText] = useState("");
  const [where, setWhere] = useState<"before" | "after">("after");
  const [base, setBase] = useState("");
  const [start, setStart] = useState(1);
  const [digits, setDigits] = useState(1);
  const [busy, setBusy] = useState(false);

  const rule: RenameRule =
    kind === "replace"
      ? { kind, find, replace, regex, caseSensitive }
      : kind === "add"
        ? { kind, text, where }
        : { kind, base, start, digits, where };

  // Names already in the affected folders, for collision checks.
  const dirs = useDirCache((s) => s.dirs);
  const siblings = new Set(
    [...new Set(entries.map((e) => parent(e.path) ?? "/"))].flatMap(
      (d) => dirs[d]?.entries.map((e) => e.name.toLowerCase()) ?? [],
    ),
  );
  const items = entries.map((e) => ({ path: e.path, name: e.name, isFolder: isFolderLike(e) }));
  const preview = previewRenames(items, rule, siblings);
  const regexError = rule.kind === "replace" && rule.regex && rule.find ? findPattern(rule) : null;
  const changes = preview.filter((p) => p.newName !== p.name);
  const problems = preview.filter((p) => p.problem && p.newName !== p.name).length;
  const canApply = changes.length > 0 && problems === 0 && typeof regexError !== "string" && !busy;

  const apply = async () => {
    setBusy(true);
    try {
      const out = await unwrap(
        commands.batchRename(changes.map((p) => ({ path: p.path, newName: p.newName }))),
      );
      applyFsChanges(
        out.entries,
        changes.map((p) => p.path),
      );
      recordUndo(out.undo);
      onClose();
    } catch (err) {
      toast.error(err instanceof CommandError ? err.message : "Couldn’t rename the items.");
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-3 p-4 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (canApply) void apply();
      }}
    >
      <h2 className="m-0 text-[14px] font-semibold">Rename {entries.length} Items</h2>
      <select
        aria-label="Rename mode"
        value={kind}
        onChange={(e) => setKind(e.target.value as RenameRule["kind"])}
        className={`${input} w-48`}
      >
        <option value="replace">Replace Text</option>
        <option value="add">Add Text</option>
        <option value="format">Format</option>
      </select>

      {kind === "replace" && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2">
          <label htmlFor="br-find">Find:</label>
          <input
            id="br-find"
            // biome-ignore lint/a11y/noAutofocus: the dialog's first field
            autoFocus
            value={find}
            spellCheck={false}
            onChange={(e) => setFind(e.target.value)}
            className={input}
          />
          <label htmlFor="br-replace">Replace with:</label>
          <input
            id="br-replace"
            value={replace}
            spellCheck={false}
            onChange={(e) => setReplace(e.target.value)}
            className={input}
          />
          <span />
          <div className="flex gap-4 text-[12px]">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              Match case
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
              Regular expression ($1 for groups)
            </label>
          </div>
          {typeof regexError === "string" && (
            <p className="col-span-2 m-0 text-[12px] text-red-500">{regexError}</p>
          )}
        </div>
      )}

      {kind === "add" && (
        <div className="flex items-center gap-2">
          <input
            aria-label="Text to add"
            // biome-ignore lint/a11y/noAutofocus: the dialog's first field
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={`${input} flex-1`}
          />
          <WhereSelect value={where} onChange={setWhere} />
        </div>
      )}

      {kind === "format" && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-2">
          <label htmlFor="br-base">Custom name:</label>
          <div className="flex gap-2">
            <input
              id="br-base"
              // biome-ignore lint/a11y/noAutofocus: the dialog's first field
              autoFocus
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className={`${input} flex-1`}
            />
            <WhereSelect value={where} onChange={setWhere} />
          </div>
          <label htmlFor="br-start">Start numbers at:</label>
          <div className="flex items-center gap-2">
            <input
              id="br-start"
              type="number"
              min={0}
              value={start}
              onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
              className={`${input} w-24`}
            />
            <label htmlFor="br-digits">Digits:</label>
            <input
              id="br-digits"
              type="number"
              min={1}
              max={9}
              value={digits}
              onChange={(e) => setDigits(Math.min(9, Math.max(1, Number(e.target.value) || 1)))}
              className={`${input} w-16`}
            />
          </div>
        </div>
      )}

      <div className="max-h-[240px] overflow-y-auto rounded-md border border-border">
        <table className="w-full border-collapse text-[12px]">
          <tbody>
            {preview.slice(0, PREVIEW_ROWS).map((p) => {
              const changed = p.newName !== p.name;
              return (
                <tr key={p.path} className="border-b border-border last:border-0">
                  <td className="max-w-0 truncate px-2 py-1 text-fg-muted" title={p.name}>
                    {p.name}
                  </td>
                  <td className="w-4 text-center text-fg-faint">→</td>
                  <td
                    className={`max-w-0 truncate px-2 py-1 ${p.problem && changed ? "text-red-500" : changed ? "" : "text-fg-faint"}`}
                    title={p.problem && changed ? p.problem : p.newName}
                  >
                    {p.newName}
                    {p.problem && changed && <span className="ml-1.5 text-[11px]">({p.problem})</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between">
        <p className="m-0 text-[12px] text-fg-muted">
          {problems > 0
            ? `${problems} name${problems === 1 ? "" : "s"} can’t be used`
            : `${changes.length} of ${entries.length} will be renamed`}
        </p>
        <div className="flex gap-2">
          <DialogButton onClick={onClose}>Cancel</DialogButton>
          <button
            type="submit"
            disabled={!canApply}
            className="h-7 rounded-md bg-accent px-3 text-[13px] text-white disabled:opacity-40"
          >
            Rename
          </button>
        </div>
      </div>
    </form>
  );
}

function WhereSelect({
  value,
  onChange,
}: {
  value: "before" | "after";
  onChange: (v: "before" | "after") => void;
}) {
  return (
    <select
      aria-label="Position"
      value={value}
      onChange={(e) => onChange(e.target.value as "before" | "after")}
      className={input}
    >
      <option value="after">after name</option>
      <option value="before">before name</option>
    </select>
  );
}
