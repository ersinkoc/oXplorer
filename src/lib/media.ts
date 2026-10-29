import type { FileEntry } from "@/lib/ipc";

/** Picture extensions the webview (and macOS's image tools) can open. */
export const IMAGE_EXTENSIONS = new Set(
  "png jpg jpeg gif webp avif bmp ico svg heic heif tif tiff".split(" "),
);

/** Images Convert Image can read (sips doesn't rasterize SVG). */
export function isConvertibleImage(entry: FileEntry): boolean {
  const ext = entry.extension?.toLowerCase() ?? "";
  return entry.kind === "file" && ext !== "svg" && IMAGE_EXTENSIONS.has(ext);
}
