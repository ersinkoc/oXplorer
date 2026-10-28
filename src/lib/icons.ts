import type { FileEntry } from "@/lib/ipc";

/** Pixel sizes the `oxthumb://` handler accepts (see src-tauri/src/uri_scheme.rs). */
export type IconPx = 16 | 32 | 64 | 128 | 256 | 512 | 1024;

const BASE = "oxthumb://localhost";

/** Extensions QuickLook renders a meaningful content preview for. */
const THUMBNAIL_EXTENSIONS = new Set(
  "png jpg jpeg gif webp heic heif tif tiff bmp svg ico icns raw cr2 nef arw dng psd pdf mp4 mov m4v avi mkv webm key pages numbers".split(
    " ",
  ),
);

/**
 * Native icon URL. Plain files share one URL per extension so WebKit caches a
 * single image for every `.pdf`; folders, packages and extensionless files can
 * have their own icon, so they're addressed by path.
 */
export function iconUrl(entry: FileEntry, px: IconPx): string {
  const ext = entry.extension?.toLowerCase();
  if (entry.kind === "file" && ext) return `${BASE}/ext/${px}/${encodeURIComponent(ext)}`;
  // Inside an archive or on a server nothing is on disk: a plain folder icon (that of /usr) stands in.
  if (entry.path.startsWith("archive:") || entry.path.startsWith("remote:"))
    return `${BASE}/path/${px}/${encodeURIComponent(entry.kind === "dir" ? "/usr" : "/dev/null")}`;
  return `${BASE}/path/${px}/${encodeURIComponent(entry.path)}`;
}

/** Icon of a path when only the path is known (folders in tabs). */
export function pathIconUrl(path: string, px: IconPx): string {
  return `${BASE}/path/${px}/${encodeURIComponent(path)}`;
}

/** Content thumbnail where QuickLook can make one, otherwise the icon. */
export function thumbnailUrl(entry: FileEntry, px: IconPx): string {
  const ext = entry.extension?.toLowerCase();
  if (
    entry.kind !== "file" ||
    !ext ||
    !THUMBNAIL_EXTENSIONS.has(ext) ||
    entry.path.startsWith("archive:") ||
    entry.path.startsWith("remote:")
  )
    return iconUrl(entry, px);
  // The modification time busts the cache when the file changes.
  return `${BASE}/thumb/${px}/${encodeURIComponent(entry.path)}?v=${entry.modifiedMs}-${entry.size}`;
}

/** Finder label colors, indexed by `FinderTag.color`. */
export const TAG_COLORS = [
  "",
  "#8e8e93",
  "#30c759",
  "#af52de",
  "#007aff",
  "#ffcc00",
  "#ff3b30",
  "#ff9500",
] as const;
