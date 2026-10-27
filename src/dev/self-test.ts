import { Channel, convertFileSrc } from "@tauri-apps/api/core";
import { info, error as logError } from "@tauri-apps/plugin-log";
import { commands, type MeasureEvent } from "@/bindings";
import { runJob } from "@/commands/jobs";
import { unwrap } from "@/lib/ipc";
import { join } from "@/lib/path";

/**
 * Dev-only end-to-end check of the file-operation IPC path (start with
 * `OX_SELFTEST_DIR=/some/empty/dir pnpm tauri dev`). Results go to the log.
 */
export async function runSelfTest(): Promise<void> {
  const dir = await commands.selfTestDir();
  if (!dir) return;
  const step = (name: string, ok: boolean, detail = "") =>
    void (ok ? info(`selftest ok: ${name} ${detail}`) : logError(`selftest FAIL: ${name} ${detail}`));
  try {
    const folder = await unwrap(commands.createItem(dir, "selftest folder", true));
    const note = await unwrap(commands.createItem(dir, "note.txt", false));
    step("create", folder.kind === "dir" && note.name === "note.txt");

    const copied = await runJob(
      { kind: "copy", sources: [note.path], destDir: folder.path },
      { history: "none" },
    );
    step(
      "copy",
      copied?.created[0]?.path === join(folder.path, "note.txt"),
      `${copied?.failures.length} failures`,
    );

    const dup = await runJob({ kind: "duplicate", sources: [note.path] }, { history: "none" });
    step("duplicate", dup?.created[0]?.name === "note copy.txt", dup?.created[0]?.name ?? "");

    const trashed = await runJob({ kind: "trash", paths: [note.path] }, { history: "none" });
    step("trash", trashed?.removed[0] === note.path && !!trashed.undo);
    const back = trashed?.undo
      ? await runJob({ kind: "undo", action: trashed.undo }, { history: "none" })
      : null;
    step("undo trash", back?.created[0]?.path === note.path, JSON.stringify(back?.failures ?? []));

    const renamed = await unwrap(commands.renamePath(note.path, "renamed.txt"));
    step("rename", renamed.name === "renamed.txt");

    const size = await new Promise<number>((resolve) => {
      const ch = new Channel<MeasureEvent>();
      ch.onmessage = (ev) => ev.type === "done" && resolve(ev.size.files);
      void commands.measure(crypto.randomUUID(), [dir], ch);
    });
    step("measure", size === 3, `${size} files`);

    // Preview pane: text head, and `asset://` only serving files explicitly allowed.
    const text = await unwrap(commands.previewText(renamed.path));
    step("preview text", !text.binary && !text.truncated && text.text === "");
    const icon = await unwrap(commands.dragPreview(dir));
    const png = (
      await runJob({ kind: "copy", sources: [icon], destDir: dir }, { history: "none", select: false })
    )?.created[0]?.path;
    if (png) {
      step("asset denied before allow", !(await loadsImage(convertFileSrc(png))));
      await unwrap(commands.allowPreview(png));
      step("asset served after allow", await loadsImage(convertFileSrc(png)));
      const folderDenied = await commands.allowPreview(dir);
      step("asset scope refuses folders", folderDenied.status === "error");
    } else {
      step("preview image copy", false);
    }

    // Native Quick Look panel opens and closes through the controller hooks.
    await unwrap(commands.quickLook([renamed.path], 0, true));
    await sleep(800);
    const shown = await commands.quickLookVisible();
    await unwrap(commands.quickLookClose());
    await sleep(400);
    step("quick look panel", shown && !(await commands.quickLookVisible()), `shown=${shown}`);

    const gone = await runJob(
      {
        kind: "delete",
        paths: [folder.path, renamed.path, join(dir, "note copy.txt"), ...(png ? [png] : [])],
      },
      { history: "none" },
    );
    step("delete", gone?.removed.length === (png ? 4 : 3) && gone.failures.length === 0);
  } catch (err) {
    step("exception", false, String(err));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function loadsImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}
