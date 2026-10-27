import type { ITheme } from "@xterm/xterm";

/** Close to Terminal.app's "Basic" profile in each appearance. */
const LIGHT: ITheme = {
  background: "#ffffff",
  foreground: "#1d1d1f",
  cursor: "#1d1d1f",
  cursorAccent: "#ffffff",
  selectionBackground: "#b3d7ff",
  black: "#000000",
  red: "#c23621",
  green: "#25bc24",
  yellow: "#adad27",
  blue: "#492ee1",
  magenta: "#d338d3",
  cyan: "#33bbc8",
  white: "#cbcccd",
  brightBlack: "#818383",
  brightRed: "#fc391f",
  brightGreen: "#31e722",
  brightYellow: "#eaec23",
  brightBlue: "#5833ff",
  brightMagenta: "#f935f8",
  brightCyan: "#14f0f0",
  brightWhite: "#e9ebeb",
};

const DARK: ITheme = {
  ...LIGHT,
  background: "#1e1e1e",
  foreground: "#e8e8ea",
  cursor: "#e8e8ea",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#3f638b",
  blue: "#6a7bff",
  brightBlue: "#8c99ff",
};

export const darkScheme = () => window.matchMedia("(prefers-color-scheme: dark)");

export function terminalTheme(): ITheme {
  return darkScheme().matches ? DARK : LIGHT;
}
