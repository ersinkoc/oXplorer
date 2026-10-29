import prettyBytes from "pretty-bytes";
import { msg, t } from "@/i18n";
import type { FileEntry } from "@/lib/ipc";

/** Finder uses base-10 units with one decimal ("2,1 MB"). */
export function formatSize(bytes: number): string {
  if (bytes === 0) return t("Zero bytes");
  return prettyBytes(bytes, { locale: true, maximumFractionDigits: 1 });
}

/** `measured` is a folder's size from Calculate Folder Sizes, still counting while `done` is false. */
export function entrySizeLabel(entry: FileEntry, measured?: { bytes: number; done: boolean }): string {
  if (!isFolderLike(entry)) return formatSize(entry.size);
  if (!measured) return "--";
  return measured.done ? formatSize(measured.bytes) : `${formatSize(measured.bytes)}…`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const DAY = 86_400_000;

/** Finder-style: "Today at 10:30", "Yesterday at 09:12", "27 Oct 2026 at 10:30". */
export function formatDate(ms: number, now: number = Date.now()): string {
  if (!ms) return "--";
  const d = new Date(ms);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const time = timeFmt.format(d);
  if (ms >= t0 && ms < t0 + DAY) return t("Today at {time}", { time });
  if (ms >= t0 - DAY && ms < t0) return t("Yesterday at {time}", { time });
  return t("{date} at {time}", { date: dateFmt.format(d), time });
}

/** Directories, and symlinks that point at directories, are navigable. */
export function isFolderLike(entry: FileEntry): boolean {
  return entry.kind === "dir" || (entry.kind === "symlink" && !!entry.symlink?.targetIsDir);
}

/** Kind names, translated where they're shown; product names stay as they are. */
const KINDS: Record<string, string> = {
  txt: msg("Plain Text"),
  md: "Markdown",
  pdf: msg("PDF document"),
  png: msg("PNG image"),
  jpg: msg("JPEG image"),
  jpeg: msg("JPEG image"),
  heic: msg("HEIF image"),
  gif: msg("GIF image"),
  webp: msg("WebP image"),
  svg: msg("SVG image"),
  mp4: msg("MPEG-4 movie"),
  mov: msg("QuickTime movie"),
  mp3: msg("MP3 audio"),
  wav: msg("Waveform audio"),
  zip: msg("ZIP archive"),
  gz: msg("gzip archive"),
  dmg: msg("Disk Image"),
  json: "JSON",
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  rs: msg("Rust source"),
  html: msg("HTML document"),
  css: "CSS",
  sh: msg("Shell script"),
  py: msg("Python script"),
  docx: msg("Word document"),
  xlsx: msg("Excel spreadsheet"),
  pptx: msg("PowerPoint presentation"),
};

export function kindLabel(entry: FileEntry): string {
  switch (entry.kind) {
    case "dir":
      return t("Folder");
    case "package":
      return entry.extension?.toLowerCase() === "app" ? t("Application") : t("Package");
    case "symlink":
      return entry.symlink?.broken ? t("Broken alias") : t("Alias");
    case "other":
      return t("Special file");
    case "file": {
      const ext = entry.extension?.toLowerCase();
      if (!ext) return t("Document");
      const kind = KINDS[ext];
      return kind ? t(kind) : t("{ext} file", { ext: ext.toUpperCase() });
    }
  }
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}
