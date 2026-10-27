/// <reference lib="webworker" />
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import { languageFor } from "@/workers/highlight-language";

export interface HighlightRequest {
  id: number;
  fileName: string;
  text: string;
}

export interface HighlightResponse {
  id: number;
  /** Escaped, highlighted HTML; null when the language is unknown or highlighting failed. */
  html: string | null;
}

const KNOWN = new Set(Object.keys(bundledLanguages));
const THEMES = { light: "github-light", dark: "github-dark" } as const;

// The JavaScript regex engine avoids WebAssembly, which the CSP doesn't allow.
let highlighter: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

async function highlight({ fileName, text }: HighlightRequest): Promise<string | null> {
  const lang = languageFor(fileName, KNOWN);
  const load = lang ? bundledLanguages[lang as keyof typeof bundledLanguages] : undefined;
  if (!lang || !load) return null;
  const hl = await getHighlighter();
  if (!hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(load);
  return hl.codeToHtml(text, {
    lang,
    themes: THEMES,
    defaultColor: false,
    // Minified one-line files would take seconds; their long lines stay plain.
    tokenizeMaxLineLength: 2000,
  });
}

self.onmessage = (e: MessageEvent<HighlightRequest>) => {
  const { id } = e.data;
  highlight(e.data)
    .then((html) => self.postMessage({ id, html } satisfies HighlightResponse))
    .catch(() => self.postMessage({ id, html: null } satisfies HighlightResponse));
};
