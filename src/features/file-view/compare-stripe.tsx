import { msg, useT } from "@/i18n";
import type { CompareMark } from "@/lib/compare";

const STYLES: Record<Exclude<CompareMark, "same">, { color: string; label: string }> = {
  only: { color: "#3fb950", label: msg("Only in this pane") },
  newer: { color: "#4c8ff5", label: msg("Newer in this pane") },
  older: { color: "#8b949e", label: msg("Older in this pane") },
  different: { color: "#d29922", label: msg("Same date, different size") },
};

/** A colored bar at the start of a row while the panes are compared. */
export function CompareStripe({ mark }: { mark: CompareMark | undefined }) {
  const { t } = useT();
  if (!mark || mark === "same") return null;
  const s = STYLES[mark];
  return (
    <span
      role="img"
      aria-label={t(s.label)}
      title={t(s.label)}
      className="absolute top-1 bottom-1 left-0 w-[3px] rounded-full"
      style={{ background: s.color }}
    />
  );
}
