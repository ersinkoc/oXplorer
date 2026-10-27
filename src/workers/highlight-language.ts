/** Extensions whose shiki language id differs from the extension itself. */
const EXTENSION_LANGS: Record<string, string> = {
  plist: "xml",
  htm: "html",
  h: "c",
  hpp: "cpp",
  hh: "cpp",
  m: "objective-c",
  mm: "objective-cpp",
  patch: "diff",
  gitignore: "ignore",
  env: "dotenv",
  zshrc: "shellscript",
  bashrc: "shellscript",
  conf: "ini",
  cfg: "ini",
  entitlements: "xml",
  xcconfig: "ini",
  lock: "json",
};

/** Names without (or with a misleading) extension. */
const FILE_NAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  podfile: "ruby",
  gemfile: "ruby",
  rakefile: "ruby",
  brewfile: "ruby",
  justfile: "just",
  ".gitignore": "ignore",
  ".gitattributes": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".env": "dotenv",
  ".zshrc": "shellscript",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zprofile": "shellscript",
  ".profile": "shellscript",
  "cargo.lock": "toml",
  "pnpm-lock.yaml": "yaml",
  "package-lock.json": "json",
};

/**
 * Picks a shiki language id for a file name; `known` is the set of ids the
 * bundle ships (aliases included). Unknown → null, the text stays plain.
 */
export function languageFor(fileName: string, known: ReadonlySet<string>): string | null {
  const name = fileName.toLowerCase();
  const byName = FILE_NAMES[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1);
  const lang = EXTENSION_LANGS[ext] ?? ext;
  return known.has(lang) ? lang : null;
}
