import type { GitState } from "@/bindings";
import { msg, useT } from "@/i18n";

const BADGES: Record<Exclude<GitState, "ignored">, { letter: string; label: string; color: string }> = {
  modified: { letter: "M", label: msg("Git: modified"), color: "#d29922" },
  added: { letter: "A", label: msg("Git: added"), color: "#3fb950" },
  untracked: { letter: "U", label: msg("Git: untracked"), color: "#3fb950" },
  renamed: { letter: "R", label: msg("Git: renamed"), color: "#4c8ff5" },
  deleted: { letter: "D", label: msg("Git: deleted"), color: "#f85149" },
  conflict: { letter: "!", label: msg("Git: conflict"), color: "#f85149" },
};

/** Git state after a name, like editors show it. Ignored items are dimmed instead. */
export function GitBadge({ state }: { state: GitState | undefined }) {
  const { t } = useT();
  if (!state || state === "ignored") return null;
  const b = BADGES[state];
  return (
    <span
      role="img"
      title={t(b.label)}
      aria-label={t(b.label)}
      className="ml-1 shrink-0 font-mono text-[10px] font-semibold"
      style={{ color: b.color }}
    >
      {b.letter}
    </span>
  );
}
