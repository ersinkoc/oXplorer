import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/**
 * The main window keeps the session, opens folders sent by other apps and
 * checks for updates; windows from File → New Window ("window-2", …) start
 * fresh and are forgotten when closed.
 */
export const isMainWindow = getCurrentWebviewWindow().label === "main";
