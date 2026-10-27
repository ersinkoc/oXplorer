import { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { hostname } from "@tauri-apps/plugin-os";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { commands, type PtyEvent_Deserialize, type PtyEvent_Serialize } from "@/bindings";
import { navigateTo } from "@/commands/navigation";
import { registerTerminal } from "@/features/terminal/terminal-registry";
import { darkScheme, terminalTheme } from "@/features/terminal/terminal-theme";
import { describeError, toAppError } from "@/lib/ipc";
import { parseOsc7 } from "@/lib/shell";
import { useApp } from "@/stores/app-store";
import { type TerminalSession, useTerminals } from "@/stores/terminal-store";
import { getActiveTab } from "@/stores/workspace-store";

const RESIZE_DEBOUNCE_MS = 50;

let localHost: Promise<string | null> | null = null;
const getHost = () => {
  localHost ??= hostname().catch(() => null);
  return localHost;
};

/** The shell reported a new directory; in Link mode the active pane follows. */
async function onCwd(id: string, data: string): Promise<void> {
  const host = await getHost();
  const dir = parseOsc7(data, host ? [host, host.replace(/\.local$/, "")] : []);
  if (!dir) return;
  const { sessions, activeId, update } = useTerminals.getState();
  update(id, { cwd: dir });
  const session = sessions.find((s) => s.id === id);
  if (session?.linked && activeId === id && getActiveTab().path !== dir) navigateTo(dir);
}

/** One xterm.js instance bound to one shell. Stays mounted while hidden. */
export function TerminalView({ session, active }: { session: TerminalSession; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const focusSeq = useTerminals((s) => s.focusSeq);
  const { id } = session;

  // biome-ignore lint/correctness/useExhaustiveDependencies: one shell per session id; cwd is only the start folder
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, monospace',
      fontSize: useApp.getState().terminalFontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // Like Terminal.app: ⌘-click opens a link.
    term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.metaKey && /^https?:/i.test(uri)) void openUrl(uri);
      }),
    );
    term.open(el);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {
      // The DOM renderer is the fallback.
    }
    fit.fit();
    fitRef.current = fit;
    termRef.current = term;
    const unregister = registerTerminal(id, term);

    const channel = new Channel<PtyEvent_Deserialize>();
    channel.onmessage = (raw) => {
      const ev = raw as PtyEvent_Serialize;
      if (ev.type === "output") term.write(ev.data);
      else {
        useTerminals.getState().update(id, { exited: true });
        term.write(`\r\n\x1b[2m[Process completed${ev.code ? ` with code ${ev.code}` : ""}]\x1b[0m\r\n`);
      }
    };
    void commands.ptyOpen(id, session.cwd, term.cols, term.rows, channel).then((r) => {
      if (r.status === "error") term.write(`\x1b[31m${describeError(toAppError(r.error))}\x1b[0m\r\n`);
    });
    const subs = [
      term.onData((data) => void commands.ptyWrite(id, data)),
      term.onResize(({ cols, rows }) => void commands.ptyResize(id, cols, rows)),
      term.parser.registerOscHandler(7, (data) => {
        void onCwd(id, data);
        return true;
      }),
    ];

    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      // A hidden terminal has no size; it is fitted when shown again.
      timer = setTimeout(() => el.offsetParent && fit.fit(), RESIZE_DEBOUNCE_MS);
    });
    ro.observe(el);
    const scheme = darkScheme();
    const onScheme = () => {
      term.options.theme = terminalTheme();
    };
    scheme.addEventListener("change", onScheme);

    return () => {
      clearTimeout(timer);
      ro.disconnect();
      scheme.removeEventListener("change", onScheme);
      for (const s of subs) s.dispose();
      unregister();
      void commands.ptyClose(id);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [id]);

  const fontSize = useApp((s) => s.terminalFontSize);
  useEffect(() => {
    const term = termRef.current;
    if (!term || term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
  }, [fontSize]);

  // Shown again, or asked to take focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: focusSeq is the "take focus" signal
  useEffect(() => {
    if (!active) return;
    fitRef.current?.fit();
    termRef.current?.focus();
  }, [active, focusSeq]);

  return (
    <div
      ref={ref}
      data-terminal-id={id}
      hidden={!active}
      className="terminal-view min-h-0 flex-1 px-2 pt-1"
      style={{ background: "var(--terminal-bg)" }}
    />
  );
}
