import { error as logError } from "@tauri-apps/plugin-log";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app";
import "@/styles/globals.css";

// Webview errors land in the same log file as Rust's (Console.app / stdout in dev).
window.addEventListener("error", (e) => void logError(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener(
  "unhandledrejection",
  (e) => void logError(`unhandled rejection: ${String(e.reason)}`),
);

document.addEventListener(
  "securitypolicyviolation",
  (e) => void logError(`CSP blocked ${e.blockedURI} (${e.violatedDirective})`),
);

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
