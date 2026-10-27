import { useState } from "react";
import { type IconPx, iconUrl, thumbnailUrl } from "@/lib/icons";
import type { FileEntry } from "@/lib/ipc";

/**
 * Native macOS icon (or QuickLook thumbnail) served by the `oxthumb://` scheme.
 * `size` is in CSS pixels; the image is requested at 2x for Retina.
 */
export function FileIcon({
  entry,
  size,
  thumbnail = false,
  className,
}: {
  entry: FileEntry;
  size: 16 | 32 | 64 | 128;
  thumbnail?: boolean;
  className?: string;
}) {
  const px = (size * 2) as IconPx;
  const src = thumbnail ? thumbnailUrl(entry, px) : iconUrl(entry, px);
  const [failed, setFailed] = useState<string | null>(null);

  if (failed === src) {
    return (
      <span
        aria-hidden
        className={`${className ?? ""} inline-block rounded-sm bg-fg-faint/30`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      loading="lazy"
      decoding="async"
      width={size}
      height={size}
      onError={() => setFailed(src)}
      className={`${className ?? ""} object-contain`}
      style={{ width: size, height: size }}
    />
  );
}
