import { convertFileSrc } from "@tauri-apps/api/core";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { commands, type TextPreview } from "@/bindings";
import { openEntries } from "@/commands/navigation";
import { useVisibleEntries } from "@/features/file-view/use-visible-entries";
import { toggleQuickLook } from "@/features/preview/quick-look";
import { entrySizeLabel, formatDate, formatSize, isFolderLike, kindLabel } from "@/lib/format";
import { iconUrl, TAG_COLORS, thumbnailUrl } from "@/lib/icons";
import { type FileEntry, unwrap } from "@/lib/ipc";
import { useDirCache } from "@/stores/dir-cache-store";
import { useWorkspace } from "@/stores/workspace-store";

const IMAGE = new Set("png jpg jpeg gif webp avif bmp ico svg heic heif tif tiff".split(" "));
const VIDEO = new Set("mp4 m4v mov webm".split(" "));
const AUDIO = new Set("mp3 m4a aac wav aif aiff flac ogg opus caf".split(" "));
/** QuickLook renders these better than any in-app viewer. */
const DOCUMENT = new Set("pdf key pages numbers docx xlsx pptx doc xls ppt rtf psd".split(" "));
/** Text is tried for anything else up to this size; Rust reads only the head anyway. */
const TEXT_MAX_BYTES = 64 * 1024 * 1024;
/** Arrowing through a folder shouldn't fetch every file it passes. */
const SETTLE_MS = 120;

type Kind = "folder" | "image" | "video" | "audio" | "document" | "text";

function previewKind(entry: FileEntry): Kind {
  if (isFolderLike(entry) || entry.kind === "package") return "folder";
  const ext = entry.extension?.toLowerCase() ?? "";
  if (IMAGE.has(ext)) return "image";
  if (VIDEO.has(ext)) return "video";
  if (AUDIO.has(ext)) return "audio";
  if (DOCUMENT.has(ext) || entry.size > TEXT_MAX_BYTES) return "document";
  return "text";
}

/** Right-hand column: what the active pane's selection looks like and what it is. */
export function PreviewPane({ width }: { width: number }) {
  const pane = useWorkspace((s) => s.activePane);
  const { tab, entries } = useVisibleEntries(pane);
  const selected = entries.filter((e) => tab.selection.paths.has(e.path));
  const focused = selected.find((e) => e.path === tab.selection.focus) ?? selected[0];

  return (
    <aside
      aria-label="Preview"
      style={{ width }}
      className="flex shrink-0 flex-col overflow-hidden bg-bg-alt"
    >
      {selected.length > 1 ? (
        <Summary entries={selected} />
      ) : focused ? (
        <EntryPreview key={focused.path} entry={focused} />
      ) : (
        <FolderSummary path={tab.path} />
      )}
    </aside>
  );
}

function EntryPreview({ entry }: { entry: FileEntry }) {
  const kind = previewKind(entry);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <Content entry={entry} kind={kind} />
      </div>
      <InfoCard entry={entry} />
    </div>
  );
}

/** Waits until the selection rests, then lets `asset://` serve this one file. */
function useAllowedSrc(entry: FileEntry, enabled: boolean): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    const timer = setTimeout(() => {
      void commands.allowPreview(entry.path).then((r) => {
        if (!stale && r.status === "ok") setSrc(convertFileSrc(entry.path));
      });
    }, SETTLE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [entry.path, enabled]);
  return src;
}

function Content({ entry, kind }: { entry: FileEntry; kind: Kind }) {
  const media = kind === "image" || kind === "video" || kind === "audio";
  const src = useAllowedSrc(entry, media);
  const [failed, setFailed] = useState(false);

  if (kind === "text") return <TextContent entry={entry} />;
  if (media && src && !failed) {
    if (kind === "image")
      return (
        <img
          src={src}
          alt={entry.name}
          draggable={false}
          onError={() => setFailed(true)}
          className="max-h-full max-w-full rounded-sm object-contain shadow-sm"
        />
      );
    // Arbitrary user files have no caption tracks.
    if (kind === "video")
      return (
        <video
          src={src}
          controls
          onError={() => setFailed(true)}
          className="max-h-full max-w-full rounded-sm"
        >
          <track kind="captions" />
        </video>
      );
    return (
      <div className="flex w-full flex-col items-center gap-4">
        <BigIcon entry={entry} />
        <audio src={src} controls onError={() => setFailed(true)} className="w-full">
          <track kind="captions" />
        </audio>
      </div>
    );
  }
  return <BigIcon entry={entry} thumbnail={kind !== "folder"} />;
}

function BigIcon({ entry, thumbnail = false }: { entry: FileEntry; thumbnail?: boolean }) {
  const [fallback, setFallback] = useState(false);
  const src = thumbnail && !fallback ? thumbnailUrl(entry, 1024) : iconUrl(entry, 512);
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFallback(true)}
      className="max-h-full w-full max-w-[256px] object-contain"
    />
  );
}

function TextContent({ entry }: { entry: FileEntry }) {
  const [preview, setPreview] = useState<TextPreview | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(() => {
      unwrap(commands.previewText(entry.path))
        .then((p) => !stale && setPreview(p))
        .catch(() => !stale && setError(true));
    }, SETTLE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [entry.path]);

  if (error || preview?.binary) return <BigIcon entry={entry} thumbnail />;
  if (!preview) return null;
  if (preview.text.length === 0) return <p className="text-[12px] text-fg-faint">Empty file</p>;
  return (
    <div className="flex size-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-bg">
      <pre className="min-h-0 flex-1 overflow-auto p-2.5 font-mono text-[11px] leading-[1.45] [tab-size:4] select-text">
        {preview.text}
      </pre>
      {preview.truncated && (
        <p className="shrink-0 border-t border-border px-2.5 py-1 text-[11px] text-fg-faint">
          Showing the first {formatSize(preview.text.length)} of {formatSize(entry.size)}
        </p>
      )}
    </div>
  );
}

function InfoCard({ entry }: { entry: FileEntry }) {
  const rows: [string, string][] = [
    ["Kind", kindLabel(entry)],
    ["Size", isFolderLike(entry) ? "--" : entrySizeLabel(entry)],
    ["Created", entry.createdMs ? formatDate(entry.createdMs) : "--"],
    ["Modified", formatDate(entry.modifiedMs)],
  ];
  if (entry.symlink) rows.push(["Original", entry.symlink.target]);
  return (
    <div className="shrink-0 border-t border-border px-3 py-2.5">
      <p className="truncate text-[13px] font-semibold" title={entry.name}>
        {entry.name}
      </p>
      {entry.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {entry.tags.map((t) => (
            <span key={t.name} className="flex items-center gap-1 text-[11px] text-fg-muted">
              <span
                className="size-2 rounded-full"
                style={{ background: TAG_COLORS[t.color] ?? "transparent" }}
              />
              {t.name}
            </span>
          ))}
        </div>
      )}
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="m-0 truncate" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={() => void openEntries([entry])}
          className="h-6 rounded-md border border-border bg-bg px-2.5 text-[12px] hover:bg-hover"
        >
          Open
        </button>
        <button
          type="button"
          onClick={toggleQuickLook}
          title="Quick Look (Space)"
          className="flex h-6 items-center gap-1 rounded-md border border-border bg-bg px-2.5 text-[12px] hover:bg-hover"
        >
          <Eye className="size-3.5" /> Quick Look
        </button>
      </div>
    </div>
  );
}

function Summary({ entries }: { entries: FileEntry[] }) {
  const bytes = entries.reduce((sum, e) => sum + (isFolderLike(e) ? 0 : e.size), 0);
  const folders = entries.filter(isFolderLike).length;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <div className="relative h-28 w-28">
        {entries.slice(0, 3).map((e, i) => (
          <img
            key={e.path}
            src={iconUrl(e, 256)}
            alt=""
            aria-hidden
            draggable={false}
            className="absolute size-24 object-contain"
            style={{ left: i * 8, top: i * 6 }}
          />
        ))}
      </div>
      <p className="text-[13px] font-semibold">{entries.length} items</p>
      <p className="text-[11px] text-fg-muted">
        {folders > 0 && `${folders} folder${folders === 1 ? "" : "s"} · `}
        {formatSize(bytes)}
        {folders > 0 && " in files"}
      </p>
    </div>
  );
}

function FolderSummary({ path }: { path: string }) {
  const dir = useDirCache((s) => s.dirs[path]);
  const [entry, setEntry] = useState<FileEntry | null>(null);
  useEffect(() => {
    let stale = false;
    void commands.statPath(path).then((r) => !stale && r.status === "ok" && setEntry(r.data));
    return () => {
      stale = true;
    };
  }, [path]);
  if (!entry) return null;
  const count = dir?.entries.filter((e) => !e.isSystemJunk).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-3">
        <BigIcon entry={entry} />
        {count !== undefined && (
          <p className="text-[11px] text-fg-muted">
            {count} item{count === 1 ? "" : "s"}
          </p>
        )}
      </div>
      <InfoCard entry={entry} />
    </div>
  );
}
