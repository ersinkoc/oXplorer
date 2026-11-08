import type { Language } from "@/i18n";

let current = "en-US";

/**
 * The locale for numbers and dates: the macOS region when it speaks the UI
 * language (keeps e.g. en-GB dates), otherwise the UI language itself, so a
 * Turkish UI on an English Mac doesn't say "Bugün 10:30 AM".
 */
export function resolveFormatLocale(lang: Language, system: string | null): string {
  if (system && system.toLowerCase().split(/[-_]/)[0] === lang) return system.replace("_", "-");
  return lang === "tr" ? "tr-TR" : "en-US";
}

export function setFormatLocale(tag: string): void {
  current = tag;
}

export function formatLocale(): string {
  return current;
}
