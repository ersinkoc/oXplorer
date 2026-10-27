import { error as logError } from "@tauri-apps/plugin-log";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SettingsApp } from "@/features/settings/settings-app";
import "@/styles/globals.css";

window.addEventListener("error", (e) => void logError(`settings: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => void logError(`settings: ${String(e.reason)}`));

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from settings.html");

createRoot(root).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
