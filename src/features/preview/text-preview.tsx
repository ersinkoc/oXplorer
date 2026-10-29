import { lazy, Suspense, useEffect, useState } from "react";
import { commands, type TextPreview as TextData } from "@/bindings";
import { msg, useT } from "@/i18n";
import { formatSize } from "@/lib/format";
import { highlight } from "@/lib/highlight";
import { type FileEntry, unwrap } from "@/lib/ipc";

const MarkdownView = lazy(() => import("@/features/preview/markdown-view"));

const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);

/** Arrowing through a folder shouldn't read every file it passes. */
const SETTLE_MS = 120;

/**
 * Head of a text file: highlighted code, rendered Markdown (with a source
 * toggle) or plain text. `onBinary` lets the caller show an icon instead.
 */
export function TextPreview({ entry, onBinary }: { entry: FileEntry; onBinary: () => React.ReactNode }) {
  const { t } = useT();
  const [data, setData] = useState<TextData | null>(null);
  const [error, setError] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const markdown = MARKDOWN.has(entry.extension?.toLowerCase() ?? "");
  const [source, setSource] = useState(false);

  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      unwrap(commands.previewText(entry.path))
        .then((p) => {
          if (stale) return;
          setData(p);
          if (!p.binary && p.text) void highlight(entry.name, p.text).then((h) => !stale && setHtml(h));
        })
        .catch(() => !stale && setError(true));
    }, SETTLE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [entry.path, entry.name]);

  if (error) return onBinary();
  if (data?.binary) return <BinaryPreview key={entry.path} entry={entry} icon={onBinary()} />;
  if (!data) return null;
  if (data.text.length === 0) return <p className="text-[12px] text-fg-faint">{t("Empty file")}</p>;

  const rendered = markdown && !source;
  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-bg">
      {markdown && (
        <fieldset
          aria-label={t("Markdown view")}
          className="m-0 flex shrink-0 gap-0.5 border-b border-border p-1"
        >
          {(
            [
              [false, msg("Preview")],
              [true, msg("Source")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={source === value}
              onClick={() => setSource(value)}
              className={`h-5 rounded px-2 text-[11px] ${source === value ? "bg-sidebar-active text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              {t(label)}
            </button>
          ))}
        </fieldset>
      )}
      <div className="min-h-0 flex-1 overflow-auto select-text">
        {rendered ? (
          <Suspense fallback={null}>
            <MarkdownView text={data.text} />
          </Suspense>
        ) : html ? (
          <div
            className="p-2.5 font-mono text-[11px] leading-[1.45] [tab-size:4] [&_pre]:whitespace-pre"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes the file's text; the markup is its own spans
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <pre className="m-0 p-2.5 font-mono text-[11px] leading-[1.45] [tab-size:4]">{data.text}</pre>
        )}
      </div>
      {data.truncated && (
        <p className="shrink-0 border-t border-border px-2.5 py-1 text-[11px] text-fg-faint">
          {t("Showing the first {shown} of {total}", {
            shown: formatSize(new TextEncoder().encode(data.text).length),
            total: formatSize(entry.size),
          })}
        </p>
      )}
    </div>
  );
}

/** A binary file: its icon, with a button to look at its first bytes. */
function BinaryPreview({ entry, icon }: { entry: FileEntry; icon: React.ReactNode }) {
  const { t } = useT();
  const [hex, setHex] = useState<TextData | null>(null);
  const [failed, setFailed] = useState(false);
  if (!hex)
    return (
      <div className="flex size-full flex-col items-center justify-center gap-3">
        {icon}
        <button
          type="button"
          onClick={() =>
            void unwrap(commands.previewHex(entry.path))
              .then(setHex)
              .catch(() => setFailed(true))
          }
          className="h-6 rounded-md border border-border px-2.5 text-[11px] text-fg-muted hover:text-fg"
        >
          {failed ? t("Couldn’t read the file.") : t("Show Hex")}
        </button>
      </div>
    );
  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-bg">
      <pre className="m-0 min-h-0 flex-1 overflow-auto p-2.5 font-mono text-[10.5px] leading-[1.45] select-text">
        {hex.text}
      </pre>
      {hex.truncated && (
        <p className="shrink-0 border-t border-border px-2.5 py-1 text-[11px] text-fg-faint">
          {t("Showing the first {shown} of {total}", {
            shown: formatSize(4096),
            total: formatSize(entry.size),
          })}
        </p>
      )}
    </div>
  );
}
