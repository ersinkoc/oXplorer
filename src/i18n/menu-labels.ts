import { msg } from "@/i18n";

/**
 * Menu bar and system menu labels that come from Rust (`src-tauri/src/menu.rs`)
 * or AppKit rather than from a command title; their translations are sent to Rust.
 */
export const MENU_LABELS = [
  msg("OXplorer"),
  msg("File"),
  msg("Edit"),
  msg("View"),
  msg("Go"),
  msg("Window"),
  msg("Help"),
  msg("About OXplorer"),
  msg("Services"),
  msg("Hide OXplorer"),
  msg("Hide Others"),
  msg("Show All"),
  msg("Quit OXplorer"),
  msg("Minimize"),
  msg("Zoom"),
  msg("Enter Full Screen"),
] as const;
