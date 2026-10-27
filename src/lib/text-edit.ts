import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * The native Edit menu owns ⌘C/⌘X/⌘V/⌘Z so they can act on files. When a text
 * field has focus these helpers give it the usual text behavior instead.
 * `execCommand` edits keep the field's own undo stack and fire `input` events,
 * so React-controlled inputs stay in sync.
 */
export type TextField = HTMLInputElement | HTMLTextAreaElement;

export function focusedTextField(): TextField | null {
  const el = document.activeElement;
  // xterm's hidden input textarea is not a text field; terminals handle edits themselves.
  if (el?.closest(".xterm")) return null;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
}

function selectedText(el: TextField): string {
  return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
}

export async function copyText(el: TextField): Promise<void> {
  const text = selectedText(el);
  if (text) await writeText(text);
}

export async function cutText(el: TextField): Promise<void> {
  const text = selectedText(el);
  if (!text) return;
  await writeText(text);
  el.focus();
  document.execCommand("delete");
}

export async function pasteText(el: TextField): Promise<void> {
  const text = await readText().catch(() => "");
  if (!text) return;
  el.focus();
  document.execCommand(
    "insertText",
    false,
    el instanceof HTMLInputElement ? text.replace(/\r?\n/g, " ") : text,
  );
}

export function undoText(redo: boolean): void {
  document.execCommand(redo ? "redo" : "undo");
}

/** ⌘⌫ in a text field: delete from the caret to the start of the line. */
export function deleteToLineStart(el: TextField): void {
  const end = el.selectionEnd ?? 0;
  const start =
    el.selectionStart === end ? el.value.lastIndexOf("\n", end - 1) + 1 : (el.selectionStart ?? 0);
  el.setSelectionRange(start, end);
  document.execCommand("delete");
}
