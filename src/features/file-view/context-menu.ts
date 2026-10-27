import { Menu, Submenu } from "@tauri-apps/api/menu";
import { commands } from "@/bindings";
import { ARCHIVE_FORMATS, isArchive, toggleTag } from "@/commands/file-commands";
import { runCommand } from "@/commands/registry";
import { isFolderLike } from "@/lib/format";
import type { FileEntry } from "@/lib/ipc";
import { useApp } from "@/stores/app-store";
import { useHistory } from "@/stores/history-store";
import { useWorkspace } from "@/stores/workspace-store";

type Item = { text: string; command: string; enabled?: boolean } | "-";

function build(items: Item[]) {
  return items.map((i) =>
    i === "-"
      ? { item: "Separator" as const }
      : { text: i.text, enabled: i.enabled ?? true, action: () => runCommand(i.command) },
  );
}

async function openWithSubmenu(entries: readonly FileEntry[]): Promise<Submenu | null> {
  const [first] = entries;
  if (!first || entries.some((e) => isFolderLike(e))) return null;
  const res = await commands.appsForPath(first.path);
  if (res.status === "error" || res.data.length === 0) return null;
  const targets = entries.map((e) => e.path);
  return Submenu.new({
    text: "Open With",
    items: res.data.map((app) => ({
      text: app.isDefault ? `${app.name} (default)` : app.name,
      action: () => void commands.openWith(app.path, targets),
    })),
  });
}

/** Finder's sidebar tags, checked when every selected item has the tag. */
async function tagsSubmenu(entries: readonly FileEntry[]): Promise<Submenu> {
  const tags = await commands.favoriteTags();
  return Submenu.new({
    text: "Tags",
    items: tags.map((tag) => ({
      text: tag.name,
      checked: entries.length > 0 && entries.every((e) => e.tags.some((t) => t.name === tag.name)),
      action: () => void toggleTag(entries, tag),
    })),
  });
}

async function compressSubmenu(): Promise<Submenu> {
  return Submenu.new({
    text: "Compress",
    items: ARCHIVE_FORMATS.map(([format, label]) => ({
      text: label === "zip" ? "Zip Archive" : `${label} Archive`,
      action: () => runCommand(`file.compress.${format}`),
    })),
  });
}

/** Native menu for right-clicking selected items. */
export async function showItemMenu(entries: readonly FileEntry[]): Promise<void> {
  const one = entries.length === 1;
  const dual = useWorkspace.getState().dualPane;
  const [openWith, tags, compress] = await Promise.all([
    openWithSubmenu(entries),
    tagsSubmenu(entries),
    compressSubmenu(),
  ]);
  const archives = entries.filter(isArchive).length;
  const menu = await Menu.new({
    items: [
      ...build([
        { text: "Open", command: "file.open" },
        ...(one && isFolderLike(entries[0] as FileEntry)
          ? [
              { text: "Open in New Tab", command: "tab.openSelected" },
              { text: "Open in Other Pane", command: "pane.openInOther" },
            ]
          : []),
        { text: "Quick Look", command: "file.quickLook" },
      ]),
      ...(openWith ? [openWith] : []),
      ...build([
        "-",
        { text: "Move to Trash", command: "file.trash" },
        "-",
        { text: "Get Info", command: "file.getInfo" },
        { text: one ? "Rename" : `Rename ${entries.length} Items…`, command: "file.rename" },
        { text: "Duplicate", command: "file.duplicate" },
      ]),
      compress,
      ...build([
        ...(archives > 0
          ? [
              {
                text: archives === 1 ? "Extract Here" : `Extract ${archives} Archives Here`,
                command: "file.extract",
              },
            ]
          : []),
        "-",
        { text: one ? "Copy" : `Copy ${entries.length} Items`, command: "edit.copy" },
        { text: "Copy Path", command: "file.copyPath" },
        "-",
        { text: "Copy to Other Pane", command: "file.copyToOther", enabled: dual },
        { text: "Move to Other Pane", command: "file.moveToOther", enabled: dual },
        "-",
        { text: "Show in Finder", command: "file.revealInFinder" },
        "-",
      ]),
      tags,
    ],
  });
  await menu.popup();
}

/** Native menu for right-clicking empty space in a folder. */
export async function showBackgroundMenu(): Promise<void> {
  const canPaste = (await commands.pasteboardReadFiles()).length > 0;
  const { showHidden } = useApp.getState();
  const { undo } = useHistory.getState();
  const last = undo.at(-1);
  const menu = await Menu.new({
    items: build([
      { text: "New Folder", command: "file.newFolder" },
      { text: "New File", command: "file.newFile" },
      "-",
      { text: last ? `Undo ${last.label}` : "Undo", command: "edit.undo", enabled: !!last },
      { text: "Paste", command: "edit.paste", enabled: canPaste },
      "-",
      { text: "Get Info", command: "file.getInfo" },
      { text: "New Terminal at Folder", command: "terminal.new" },
      { text: showHidden ? "Hide Hidden Files" : "Show Hidden Files", command: "view.toggleHidden" },
      { text: "Show in Finder", command: "file.revealInFinder" },
    ]),
  });
  await menu.popup();
}
