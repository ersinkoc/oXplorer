import { convertFileSrc } from "@tauri-apps/api/core";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { commands } from "@/bindings";
import { materialize } from "@/commands/locations";
import { openEntries } from "@/commands/navigation";
import { useVisibleEntries } from "@/features/file-view/use-visible-entries";
import { toggleQuickLook } from "@/features/preview/quick-look";
import { TextPreview } from "@/features/preview/text-preview";
import { useT } from "@/i18n";
import { isArchivePath } from "@/lib/archive-path";
import { entrySizeLabel, formatDate, formatSize, isFolderLike, kindLabel } from "@/lib/format";
import { iconUrl, TAG_COLORS, thumbnailUrl } from "@/lib/icons";
import type { FileEntry } from "@/lib/ipc";
import { isRemotePath } from "@/lib/remote-path";
import { useDirCache } from "@/stores/dir-cache-store";
import { useFolderSizes } from "@/stores/folder-size-store";
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
  const { t } = useT();
  const pane = useWorkspace((s) => s.activePane);
  const { tab, entries } = useVisibleEntries(pane);
  const selected = entries.filter((e) => tab.selection.paths.has(e.path));
  const focused = selected.find((e) => e.path === tab.selection.focus) ?? selected[0];

  return (
    <aside
      aria-label={t("Preview")}
      style={{ width }}
      className="flex shrink-0 flex-col overflow-hidden bg-bg-alt"
    >
      {selected.length > 1 ? (
        <Summary entries={selected} />
      ) : focused ? (
        (isArchivePath(focused.path) || isRemotePath(focused.path)) && !isFolderLike(focused) ? (
          <ArchiveMemberPreview key={focused.path} entry={focused} />
        ) : (
          <EntryPreview key={focused.path} entry={focused} />
        )
      ) : (
        <FolderSummary path={tab.path} />
      )}
    </aside>
  );
}

/** A file inside an archive or on a server is previewed from a temporary copy, once the selection rests. */
function ArchiveMemberPreview({ entry }: { entry: FileEntry }) {
  const [real, setReal] = useState<FileEntry | null>(null);
  useEffect(() => {
    if (isFolderLike(entry)) return;
    let stale = false;
    const timer = setTimeout(() => {
      void materialize(entry.path)
        .then((path) => !stale && setReal({ ...entry, path }))
        .catch(() => {});
    }, SETTLE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [entry]);
  return <EntryPreview entry={real ?? entry} />;
}

export function EntryPreview({ entry }: { entry: FileEntry }) {
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

  if (kind === "text")
    return <TextPreview entry={entry} onBinary={() => <BigIcon entry={entry} thumbnail />} />;
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

function InfoCard({ entry }: { entry: FileEntry }) {
  const { t } = useT();
  const measured = useFolderSizes((s) => s.sizes[entry.path]);
  const rows: [string, string][] = [
    [t("Kind"), kindLabel(entry)],
    [t("Size"), entrySizeLabel(entry, measured)],
    [t("Created"), entry.createdMs ? formatDate(entry.createdMs) : "--"],
    [t("Modified"), formatDate(entry.modifiedMs)],
  ];
  if (entry.symlink) rows.push([t("Original"), entry.symlink.target]);
  return (
    <div className="shrink-0 border-t border-border px-3 py-2.5">
      <p className="truncate text-[13px] font-semibold" title={entry.name}>
        {entry.name}
      </p>
      {entry.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {entry.tags.map((tag) => (
            <span key={tag.name} className="flex items-center gap-1 text-[11px] text-fg-muted">
              <span
                className="size-2 rounded-full"
                style={{ background: TAG_COLORS[tag.color] ?? "transparent" }}
              />
              {tag.name}
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
          {t("Open")}
        </button>
        <button
          type="button"
          onClick={toggleQuickLook}
          title={t("Quick Look (Space)")}
          className="flex h-6 items-center gap-1 rounded-md border border-border bg-bg px-2.5 text-[12px] hover:bg-hover"
        >
          <Eye className="size-3.5" /> {t("Quick Look")}
        </button>
      </div>
    </div>
  );
}

function Summary({ entries }: { entries: FileEntry[] }) {
  const bytes = entries.reduce((sum, e) => sum + (isFolderLike(e) ? 0 : e.size), 0);
  const folders = entries.filter(isFolderLike).length;
  const { tn } = useT();
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
      <p className="text-[13px] font-semibold">{tn(entries.length, "{count} item", "{count} items")}</p>
      <p className="text-[11px] text-fg-muted">
        {folders > 0
          ? tn(folders, "{count} folder · {size} in files", "{count} folders · {size} in files", {
              size: formatSize(bytes),
            })
          : formatSize(bytes)}
      </p>
    </div>
  );
}

function FolderSummary({ path }: { path: string }) {
  const { tn } = useT();
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
          <p className="text-[11px] text-fg-muted">{tn(count, "{count} item", "{count} items")}</p>
        )}
      </div>
      <InfoCard entry={entry} />
    </div>
  );
}
