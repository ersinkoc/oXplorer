import { Menu, Submenu } from "@tauri-apps/api/menu";
import { commands } from "@/bindings";
import { ARCHIVE_FORMATS, isArchive, toggleTag } from "@/commands/file-commands";
import { runCommand } from "@/commands/registry";
import { t } from "@/i18n";
import { isFolderLike } from "@/lib/format";
import type { FileEntry } from "@/lib/ipc";
import { isConvertibleImage } from "@/lib/media";
import { isSearchPath, isVirtualPath } from "@/lib/search-path";
import { useApp } from "@/stores/app-store";
import { useHistory } from "@/stores/history-store";
import { getActiveTab, useWorkspace } from "@/stores/workspace-store";

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
  // Files, or one folder (terminals and editors open folders).
  const folder = entries.length === 1 && first?.kind === "dir";
  if (!first || (!folder && entries.some((e) => isFolderLike(e)))) return null;
  const res = await commands.appsForPath(first.path);
  if (res.status === "error" || res.data.length === 0) return null;
  const targets = entries.map((e) => e.path);
  return Submenu.new({
    text: t("Open With"),
    items: res.data.map((app) => ({
      text: app.isDefault ? t("{name} (default)", { name: app.name }) : app.name,
      action: () => void commands.openWith(app.path, targets),
    })),
  });
}

/** Finder's sidebar tags, checked when every selected item has the tag. */
async function tagsSubmenu(entries: readonly FileEntry[]): Promise<Submenu> {
  const tags = await commands.favoriteTags();
  return Submenu.new({
    text: t("Tags"),
    items: tags.map((tag) => ({
      text: tag.name,
      checked: entries.length > 0 && entries.every((e) => e.tags.some((t) => t.name === tag.name)),
      action: () => void toggleTag(entries, tag),
    })),
  });
}

async function compressSubmenu(): Promise<Submenu> {
  return Submenu.new({
    text: t("Compress"),
    items: [
      ...ARCHIVE_FORMATS.map(([format, label]) => ({
        text: label === "zip" ? t("Zip Archive") : t("{format} Archive", { format: label }),
        action: () => runCommand(`file.compress.${format}`),
      })),
      { item: "Separator" as const },
      { text: t("Zip with Password…"), action: () => runCommand("file.compress.zipPassword") },
    ],
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
        { text: t("Open"), command: "file.open" },
        ...(one && isFolderLike(entries[0] as FileEntry)
          ? [
              { text: t("Open in New Tab"), command: "tab.openSelected" },
              { text: t("Open in Other Pane"), command: "pane.openInOther" },
              ...(isVirtualPath((entries[0] as FileEntry).path)
                ? []
                : [{ text: t("Open in New Window"), command: "window.openSelected" }]),
            ]
          : []),
        ...(one && entries[0]?.kind === "package"
          ? [{ text: t("Show Package Contents"), command: "file.showPackageContents" }]
          : []),
        ...(one && isSearchPath(getActiveTab().path)
          ? [{ text: t("Show in Enclosing Folder"), command: "file.showEnclosing" }]
          : []),
        { text: t("Quick Look"), command: "file.quickLook" },
      ]),
      ...(openWith ? [openWith] : []),
      ...build([
        "-",
        { text: t("Move to Trash"), command: "file.trash" },
        "-",
        { text: t("Get Info"), command: "file.getInfo" },
        ...(entries.some((e) => e.kind === "dir")
          ? [{ text: t("Calculate Folder Sizes"), command: "view.calculateSizes" }]
          : []),
        ...(entries.length === 2 && entries.every((e) => e.kind === "file")
          ? [{ text: t("Compare Files"), command: "file.compareFiles" }]
          : []),
        {
          text: one ? t("Rename") : t("Rename {count} Items…", { count: entries.length.toLocaleString() }),
          command: "file.rename",
        },
        { text: t("Duplicate"), command: "file.duplicate" },
        { text: t("Make Alias"), command: "file.makeAlias" },
        ...(entries.some(isConvertibleImage)
          ? [{ text: t("Convert Image…"), command: "file.convertImage" }]
          : []),
        ...(entries.length > 1
          ? [
              {
                text: t("New Folder with Selection ({count} Items)", {
                  count: entries.length.toLocaleString(),
                }),
                command: "file.newFolderWithSelection",
              },
            ]
          : []),
      ]),
      compress,
      ...build([
        ...(archives > 0
          ? [
              {
                text:
                  archives === 1
                    ? t("Extract Here")
                    : t("Extract {count} Archives Here", { count: archives }),
                command: "file.extract",
              },
            ]
          : []),
        "-",
        {
          text: one ? t("Copy") : t("Copy {count} Items", { count: entries.length.toLocaleString() }),
          command: "edit.copy",
        },
        { text: t("Copy Path"), command: "file.copyPath" },
        { text: t("Copy Name"), command: "file.copyName" },
        "-",
        { text: t("Copy to Other Pane"), command: "file.copyToOther", enabled: dual },
        { text: t("Move to Other Pane"), command: "file.moveToOther", enabled: dual },
        "-",
        { text: t("Show in Finder"), command: "file.revealInFinder" },
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
  const { foldersFirst } = getActiveTab().view.sort;
  const { undo } = useHistory.getState();
  const last = undo.at(-1);
  const menu = await Menu.new({
    items: build([
      { text: t("New Folder"), command: "file.newFolder" },
      { text: t("New File"), command: "file.newFile" },
      "-",
      {
        text: last ? t("Undo {action}", { action: t(last.label) }) : t("Undo"),
        command: "edit.undo",
        enabled: !!last,
      },
      { text: t("Paste"), command: "edit.paste", enabled: canPaste },
      "-",
      { text: t("Get Info"), command: "file.getInfo" },
      { text: t("New Terminal at Folder"), command: "terminal.new" },
      { text: t("Disk Usage…"), command: "view.diskUsage" },
      "-",
      { text: t("Sort by Name"), command: "view.sortName" },
      { text: t("Sort by Kind"), command: "view.sortKind" },
      { text: t("Sort by Date Modified"), command: "view.sortModified" },
      { text: t("Sort by Date Created"), command: "view.sortCreated" },
      { text: t("Sort by Size"), command: "view.sortSize" },
      {
        text: foldersFirst ? t("Mix Folders with Files") : t("Keep Folders on Top"),
        command: "view.foldersFirst",
      },
      "-",
      { text: showHidden ? t("Hide Hidden Files") : t("Show Hidden Files"), command: "view.toggleHidden" },
      { text: t("Show in Finder"), command: "file.revealInFinder" },
    ]),
  });
  await menu.popup();
}
