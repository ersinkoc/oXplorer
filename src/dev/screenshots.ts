import { info, error as logError } from "@tauri-apps/plugin-log";
import { commands } from "@/bindings";
import { ensureListed } from "@/commands/navigation";
import { closeTerminal, openTerminal } from "@/commands/terminal-commands";
import { terminalById } from "@/features/terminal/terminal-registry";
import { archivePath } from "@/lib/archive-path";
import { join } from "@/lib/path";
import { searchPath } from "@/lib/search-path";
import { type Preferences, useApp } from "@/stores/app-store";
import { useDirCache } from "@/stores/dir-cache-store";
import { useRecents } from "@/stores/recents-store";
import { useTerminals } from "@/stores/terminal-store";
import { initialPane, type PaneId, useWorkspace } from "@/stores/workspace-store";

/**
 * Dev-only: stages the README scenes and saves each as `<OX_SHOTS_DIR>/<name>.png`
 * (run by `scripts/screenshots.sh` on the folders `scripts/demo-content.sh` makes;
 * the demo folder is the launch folder). Progress goes to the log as `shots …`.
 */
export async function runScreenshots(demo: string): Promise<void> {
  const dir = await commands.shotsDir();
  if (!dir) return;
  const aurora = join(demo, "aurora");
  const artwork = join(demo, "Artwork");
  const documents = join(demo, "Documents");
  const before = { theme: useApp.getState().theme, language: useApp.getState().languagePref };
  try {
    useApp.getState().set({ whatsNewOpen: false, fdaBannerDismissed: true });
    // Only the startup disk in the sidebar (no names of this Mac's other volumes).
    useApp.getState().set({ volumes: useApp.getState().volumes.filter((v) => v.isRoot) });
    // xterm draws with the DOM instead of WebGL, which a snapshot can't capture.
    document.documentElement.dataset.oxShots = "1";
    // The window is hidden, so WebKit never runs animation frames; xterm draws in them.
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
    useApp.getState().setPreference("languagePref", "en");
    // The palette's frequent folders: the demo's, not this machine's (in memory only).
    const now = Date.now();
    useRecents.setState({
      visits: [aurora, artwork, documents, join(aurora, "src"), demo].map((path, i) => ({
        path,
        count: 9 - i,
        last: now - i * 60_000,
      })),
    });

    // 1. Two panes: a project under Git and a folder of pictures.
    await scene({
      theme: "light",
      left: { path: aurora, select: "README.md" },
      right: { path: artwork, mode: "icons", select: "Northern Lights.jpg" },
    });
    await shoot("dual-pane");

    // 2. Dark, with the preview of a changed source file.
    await scene({
      theme: "dark",
      left: { path: join(aurora, "src"), select: "render.rs" },
      preview: true,
    });
    await settle(1500);
    await shoot("preview-dark");

    // 3. The terminal under the panes, following the shell.
    await scene({
      theme: "dark",
      left: { path: aurora },
      right: { path: documents },
    });
    await terminal(aurora, ["git status --short --branch", "git log --oneline -3", "ls src"]);
    await shoot("terminal");
    for (const s of useTerminals.getState().sessions) closeTerminal(s.id);

    // 4. Content search across the project.
    const found = searchPath({
      scope: aurora,
      query: "Vec3",
      mode: "content",
      caseSensitive: false,
      regex: false,
      includeHidden: false,
    });
    await scene({ theme: "light", left: { path: found }, right: { path: aurora } });
    await settle(2000);
    await shoot("search");

    // 5. Inside a zip, like a folder; the other pane shows the Documents.
    await scene({
      theme: "light",
      left: { path: archivePath(join(demo, "Backup 2026-09.zip"), "") },
      right: { path: documents, mode: "icons" },
    });
    await shoot("archive");

    // 6. Disk usage.
    await scene({ theme: "dark", left: { path: demo } });
    useApp.getState().set({ diskUsagePath: demo });
    await settle(2500);
    await shoot("disk-usage");
    useApp.getState().set({ diskUsagePath: null });

    // 7. The command palette.
    await scene({ theme: "light", left: { path: aurora }, right: { path: artwork, mode: "icons" } });
    useApp.getState().set({ paletteOpen: true });
    await settle(400);
    const input = document.querySelector<HTMLInputElement>("input[placeholder^='Type a command']");
    if (input) {
      // A controlled React input: set the value the way typing does.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "comp");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle(600);
    await shoot("palette");
    useApp.getState().set({ paletteOpen: false });
    void info("shots done");
  } catch (err) {
    void logError(`shots FAIL: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    useApp.getState().setPreference("theme", before.theme);
    useApp.getState().setPreference("languagePref", before.language);
  }
}

interface PaneScene {
  path: string;
  mode?: "list" | "icons" | "columns";
  select?: string;
}

async function scene(s: {
  theme: Preferences["theme"];
  left: PaneScene;
  right?: PaneScene;
  preview?: boolean;
}): Promise<void> {
  useApp.getState().setPreference("theme", s.theme);
  const ws = useWorkspace.getState();
  useWorkspace.setState({
    panes: { left: initialPane(s.left.path), right: initialPane(s.right?.path ?? s.left.path) },
    dualPane: !!s.right,
    activePane: "left",
    preview: { ...ws.preview, visible: !!s.preview, width: 600 },
  });
  const panes: [PaneId, PaneScene | undefined][] = [
    ["left", s.left],
    ["right", s.right],
  ];
  for (const [pane, p] of panes) {
    if (!p) continue;
    useWorkspace.getState().updateView({ mode: p.mode ?? "list" }, pane);
    ensureListed(p.path);
  }
  for (const [pane, p] of panes) {
    if (!p) continue;
    await waitFor(() => useDirCache.getState().dirs[p.path]?.status === "ready", 8000);
    if (p.select) {
      const path = join(p.path, p.select);
      useWorkspace.getState().setSelection({ paths: new Set([path]), anchor: path, focus: path }, pane);
    }
  }
  useWorkspace.getState().setActivePane("left");
  // Icons, thumbnails, Git badges.
  await settle(1500);
}

async function terminal(cwd: string, lines: string[]): Promise<void> {
  openTerminal(cwd);
  const { activeId } = useTerminals.getState();
  if (!activeId) return;
  await waitFor(() => {
    const buf = terminalById(activeId)?.buffer.active;
    return !!buf && (buf.cursorX > 0 || buf.cursorY > 0);
  }, 15000);
  useTerminals.getState().update(activeId, { linked: true });
  // A plain zsh (no dotfiles: no user or host name, no theme fonts) with a neutral prompt.
  await commands.ptyWrite(activeId, "exec /bin/zsh -f\r");
  await settle(1000);
  await commands.ptyWrite(activeId, "export CLICOLOR=1; PROMPT='%F{cyan}%1~%f %F{magenta}❯%f '; clear\r");
  await settle(700);
  for (const line of lines) {
    await commands.ptyWrite(activeId, `${line}\r`);
    await settle(600);
  }
  await settle(2500);
}

async function shoot(name: string): Promise<void> {
  const r = await commands.saveScreenshot(name);
  void (r.status === "ok" ? info(`shots ok: ${r.data}`) : logError(`shots FAIL: ${name} ${r.error.kind}`));
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return true;
    await settle(100);
  }
  return check();
}
