import prettyBytes from "pretty-bytes";
import type { FileEntry } from "@/lib/ipc";

/** Finder uses base-10 units with one decimal ("2,1 MB"). */
export function formatSize(bytes: number): string {
  if (bytes === 0) return "Zero bytes";
  return prettyBytes(bytes, { locale: true, maximumFractionDigits: 1 });
}

export function entrySizeLabel(entry: FileEntry): string {
  return isFolderLike(entry) ? "--" : formatSize(entry.size);
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
  if (ms >= t0 && ms < t0 + DAY) return `Today at ${time}`;
  if (ms >= t0 - DAY && ms < t0) return `Yesterday at ${time}`;
  return `${dateFmt.format(d)} at ${time}`;
}

/** Directories, and symlinks that point at directories, are navigable. */
export function isFolderLike(entry: FileEntry): boolean {
  return entry.kind === "dir" || (entry.kind === "symlink" && !!entry.symlink?.targetIsDir);
}

const KINDS: Record<string, string> = {
  txt: "Plain Text",
  md: "Markdown",
  pdf: "PDF document",
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  heic: "HEIF image",
  gif: "GIF image",
  webp: "WebP image",
  svg: "SVG image",
  mp4: "MPEG-4 movie",
  mov: "QuickTime movie",
  mp3: "MP3 audio",
  wav: "Waveform audio",
  zip: "ZIP archive",
  gz: "gzip archive",
  dmg: "Disk Image",
  json: "JSON",
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  rs: "Rust source",
  html: "HTML document",
  css: "CSS",
  sh: "Shell script",
  py: "Python script",
  docx: "Word document",
  xlsx: "Excel spreadsheet",
  pptx: "PowerPoint presentation",
};

export function kindLabel(entry: FileEntry): string {
  switch (entry.kind) {
    case "dir":
      return "Folder";
    case "package":
      return entry.extension?.toLowerCase() === "app" ? "Application" : "Package";
    case "symlink":
      return entry.symlink?.broken ? "Broken alias" : "Alias";
    case "other":
      return "Special file";
    case "file": {
      const ext = entry.extension?.toLowerCase();
      if (!ext) return "Document";
      return KINDS[ext] ?? `${ext.toUpperCase()} file`;
    }
  }
}
