import type { FinderTag } from "@/bindings";
import { TAG_COLORS } from "@/lib/icons";

/** Overlapping colored dots, like Finder shows after a file name. */
export function TagDots({ tags }: { tags: readonly FinderTag[] }) {
  const colored = tags.filter((t) => t.color > 0);
  if (colored.length === 0) return null;
  return (
    <span className="ml-1 flex shrink-0 items-center" title={tags.map((t) => t.name).join(", ")}>
      {colored.slice(0, 3).map((t, i) => (
        <span
          key={t.name}
          className="size-2.5 rounded-full ring-1 ring-bg"
          style={{ background: TAG_COLORS[t.color], marginLeft: i === 0 ? 0 : -4 }}
        />
      ))}
    </span>
  );
}
