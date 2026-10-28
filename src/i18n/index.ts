import { useMemo } from "react";
import { tr } from "@/i18n/tr";
import { useApp } from "@/stores/app-store";

/**
 * UI text is written in English in the code; `t()` looks the English text up
 * in the Turkish dictionary when Turkish is active (missing entries fall back
 * to English). `{name}` placeholders are filled from `vars`.
 *
 *   t("New Folder")
 *   t("Couldn’t open “{name}”.", { name })
 *   tn(count, "{count} item", "{count} items")
 */
export type Language = "en" | "tr";

const DICTIONARIES: Record<Language, Readonly<Record<string, string>> | null> = { en: null, tr };

function fill(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export function translate(lang: Language, text: string, vars?: Record<string, string | number>): string {
  return fill(DICTIONARIES[lang]?.[text] ?? text, vars);
}

/**
 * Marks English text that is defined in one place and translated where it's
 * shown (`t(label)`), e.g. labels in constant arrays. Returns it unchanged.
 */
export function msg(text: string): string {
  return text;
}

/** For code outside components (commands, menus, toasts): uses the current language. */
export function t(text: string, vars?: Record<string, string | number>): string {
  return translate(useApp.getState().language, text, vars);
}

/** English singular/plural choice; `{count}` is filled in. */
export function tn(
  count: number,
  one: string,
  other: string,
  vars?: Record<string, string | number>,
): string {
  return t(count === 1 ? one : other, { count: count.toLocaleString(), ...vars });
}

/**
 * In components. The functions are new for each language, so memoized JSX
 * (React Compiler) that uses them is recomputed when the language changes.
 */
export function useT(): { t: typeof t; tn: typeof tn } {
  const lang = useApp((s) => s.language);
  return useMemo(() => {
    const bound = (text: string, vars?: Record<string, string | number>) => translate(lang, text, vars);
    const boundN = (count: number, one: string, other: string, vars?: Record<string, string | number>) =>
      bound(count === 1 ? one : other, { count: count.toLocaleString(), ...vars });
    return { t: bound, tn: boundN };
  }, [lang]);
}

/** English label → translation for the native menu bar (empty for English). */
export function menuTitles(lang: Language, labels: readonly string[]): Record<string, string> {
  if (lang === "en") return {};
  return Object.fromEntries(labels.map((l) => [l, translate(lang, l)]));
}

/** "system" follows the macOS language (Turkish if it's Turkish, otherwise English). */
export function resolveLanguage(pref: "system" | Language, systemLocale: string | null): Language {
  if (pref !== "system") return pref;
  return systemLocale?.toLowerCase().startsWith("tr") ? "tr" : "en";
}
