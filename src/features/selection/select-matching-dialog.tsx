import { useState } from "react";
import { paneLayout } from "@/features/file-view/visible-order";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";
import { globMatcher } from "@/lib/glob";
import { basename } from "@/lib/path";
import { selectWhere } from "@/lib/selection";
import { useApp } from "@/stores/app-store";
import { getActiveTab, useWorkspace } from "@/stores/workspace-store";

/** The last pattern, offered again next time (Total Commander habit). */
let lastPattern = "";

/** Edit → Select Matching… / Deselect Matching…: wildcard patterns against names. */
export function SelectMatchingDialog() {
  const { t } = useT();
  const mode = useApp((s) => s.selectMatching);
  const close = () => useApp.getState().set({ selectMatching: null });
  return (
    <Dialog
      open={!!mode}
      onClose={close}
      label={mode === "deselect" ? t("Deselect Matching") : t("Select Matching")}
      className="w-[420px]"
    >
      {mode && <Body initialMode={mode} onClose={close} />}
    </Dialog>
  );
}

const input =
  "h-7 min-w-0 rounded-md border border-border bg-bg px-2 text-[13px] outline-none focus:ring-2 focus:ring-accent/40";

function Body({ initialMode, onClose }: { initialMode: "select" | "deselect"; onClose: () => void }) {
  const { t, tn } = useT();
  const [pattern, setPattern] = useState(lastPattern);
  const [mode, setMode] = useState(initialMode);
  const pane = useWorkspace((s) => s.activePane);
  const order = paneLayout(pane).order;
  const match = globMatcher(pattern);
  const count = match ? order.filter((p) => match(basename(p))).length : 0;

  const apply = () => {
    if (!match) return;
    lastPattern = pattern;
    const sel = getActiveTab(pane).selection;
    useWorkspace.getState().setSelection(
      selectWhere(sel, order, (p) => match(basename(p)), mode === "select"),
      pane,
    );
    onClose();
  };

  return (
    <form
      className="flex flex-col gap-3 p-4 text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <div className="flex items-center gap-2">
        <select
          aria-label={t("Action")}
          value={mode}
          onChange={(e) => setMode(e.target.value as "select" | "deselect")}
          className={`${input} w-32`}
        >
          <option value="select">{t("Select")}</option>
          <option value="deselect">{t("Deselect")}</option>
        </select>
        <input
          aria-label={t("Name pattern")}
          // biome-ignore lint/a11y/noAutofocus: the dialog's only field
          autoFocus
          value={pattern}
          placeholder="*.jpg; *.png"
          spellCheck={false}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setPattern(e.target.value)}
          className={`${input} flex-1`}
        />
      </div>
      <p className="m-0 text-[12px] text-fg-muted">
        {match
          ? tn(count, "1 item matches", "{count} items match")
          : t("* matches any text, ? one character; separate patterns with ;")}
      </p>
      <div className="flex justify-end gap-2">
        <DialogButton onClick={onClose}>{t("Cancel")}</DialogButton>
        <DialogButton primary onClick={apply}>
          {mode === "deselect" ? t("Deselect") : t("Select")}
        </DialogButton>
      </div>
    </form>
  );
}
