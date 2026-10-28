import { useEffect, useState } from "react";
import { commands } from "@/bindings";
import { materialize } from "@/commands/locations";
import { Dialog, DialogButton } from "@/features/ui/dialog";
import { useT } from "@/i18n";
import { CommandError, type FileEntry, unwrap } from "@/lib/ipc";
import { type DiffLine, diffLines, withContext } from "@/lib/line-diff";
import { useApp } from "@/stores/app-store";

/** Rows rendered at most; a diff longer than this is cut off with a note. */
const MAX_ROWS = 5000;

/** File → Compare Files: a unified line diff of two text files. */
export function CompareFilesDialog() {
  const { t } = useT();
  const pair = useApp((s) => s.compareFiles);
  const close = () => useApp.getState().set({ compareFiles: null });
  return (
    <Dialog
      open={!!pair}
      onClose={close}
      label={t("Compare Files")}
      className="flex h-[80vh] w-[86vw] max-w-[1100px] flex-col"
    >
      {pair && <Body key={`${pair[0].path}\n${pair[1].path}`} pair={pair} onClose={close} />}
    </Dialog>
  );
}

type Result =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "binary" }
  | { status: "tooDifferent" }
  | { status: "done"; lines: DiffLine[]; truncated: boolean };

async function readText(entry: FileEntry) {
  return unwrap(commands.previewText(await materialize(entry.path)));
}

function useDiff(left: FileEntry, right: FileEntry): Result {
  const [result, setResult] = useState<Result>({ status: "loading" });
  useEffect(() => {
    let live = true;
    void Promise.all([readText(left), readText(right)])
      .then(([a, b]) => {
        if (!live) return;
        if (a.binary || b.binary) {
          setResult({ status: "binary" });
          return;
        }
        // A cut-off file ends mid-way (last line partial): compare both up to the same line,
        // or everything past the cut would show as removed or added.
        const left = a.text.split(/\r?\n/);
        const right = b.text.split(/\r?\n/);
        const cut = Math.min(
          a.truncated ? left.length - 1 : Number.POSITIVE_INFINITY,
          b.truncated ? right.length - 1 : Number.POSITIVE_INFINITY,
        );
        const lines = diffLines(left.slice(0, cut), right.slice(0, cut));
        setResult(
          lines
            ? { status: "done", lines, truncated: a.truncated || b.truncated }
            : { status: "tooDifferent" },
        );
      })
      .catch((err: unknown) => {
        if (live)
          setResult({ status: "error", message: err instanceof CommandError ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [left, right]);
  return result;
}

function Body({ pair: [left, right], onClose }: { pair: [FileEntry, FileEntry]; onClose: () => void }) {
  const { t, tn } = useT();
  const result = useDiff(left, right);
  const added = result.status === "done" ? result.lines.filter((l) => l.kind === "add").length : 0;
  const removed = result.status === "done" ? result.lines.filter((l) => l.kind === "del").length : 0;
  const rows = result.status === "done" ? withContext(result.lines) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col text-[13px]">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate font-semibold" title={left.path}>
            <span className="text-red-500">−</span> {left.name}
          </p>
          <p className="m-0 truncate font-semibold" title={right.path}>
            <span className="text-green-600">+</span> {right.name}
          </p>
        </div>
        {result.status === "done" && (
          <p className="m-0 shrink-0 text-[12px] text-fg-muted">
            {added + removed === 0
              ? t("The files are identical.")
              : `${tn(removed, "1 line removed", "{count} lines removed")}, ${tn(added, "1 line added", "{count} lines added")}`}
          </p>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[18px]">
        {result.status === "loading" && <Note>{t("Comparing…")}</Note>}
        {result.status === "error" && <Note>{result.message}</Note>}
        {result.status === "binary" && <Note>{t("One of the files isn’t text.")}</Note>}
        {result.status === "tooDifferent" && (
          <Note>{t("The files are too different to compare line by line.")}</Note>
        )}
        {result.status === "done" && (
          <table className="w-full border-collapse">
            <tbody>
              {rows.slice(0, MAX_ROWS).map((line, i) =>
                line === null ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: gaps have no identity of their own
                  <tr key={`gap-${i}`} className="bg-bg-alt text-fg-faint">
                    <td colSpan={4} className="px-3 select-none">
                      ⋯
                    </td>
                  </tr>
                ) : (
                  <Row key={`${line.a ?? ""}:${line.b ?? ""}`} line={line} />
                ),
              )}
            </tbody>
          </table>
        )}
        {result.status === "done" && (rows.length > MAX_ROWS || result.truncated) && (
          <Note>{t("Only the first part of the files is compared.")}</Note>
        )}
      </div>

      <footer className="flex justify-end border-t border-border px-4 py-3">
        <DialogButton primary autoFocus onClick={onClose}>
          {t("Done")}
        </DialogButton>
      </footer>
    </div>
  );
}

function Row({ line }: { line: DiffLine }) {
  const tone = line.kind === "add" ? "bg-green-500/15" : line.kind === "del" ? "bg-red-500/15" : "";
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <tr className={tone}>
      <td className="w-12 px-2 text-right text-fg-faint select-none">{line.a ?? ""}</td>
      <td className="w-12 px-2 text-right text-fg-faint select-none">{line.b ?? ""}</td>
      <td className="w-4 text-fg-muted select-none">{sign}</td>
      <td className="pr-3 break-all whitespace-pre-wrap">{line.text}</td>
    </tr>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="m-0 px-4 py-3 font-sans text-[12px] text-fg-muted">{children}</p>;
}
