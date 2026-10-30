import { commands } from "@/bindings";
import { askPassword } from "@/features/ui/password-prompt";
import { t } from "@/i18n";
import { parseArchivePath } from "@/lib/archive-path";
import { describeError } from "@/lib/ipc";
import { basename } from "@/lib/path";

/** Archives whose password Rust holds for this session. */
const unlocked = new Set<string>();

/**
 * Before members of an encrypted zip are read (opened, copied out, Quick
 * Looked), asks for its password once per session. False when cancelled;
 * true for anything that needs no password.
 */
export async function unlockArchiveOf(paths: readonly string[]): Promise<boolean> {
  const archives = new Set(paths.flatMap((p) => parseArchivePath(p)?.archive ?? []));
  for (const archive of archives) {
    if (unlocked.has(archive)) continue;
    const encrypted = await commands.archiveEncrypted(archive);
    // A broken archive says so when it's read.
    if (encrypted.status !== "ok" || !encrypted.data) continue;
    let message = t("Enter the password to open its contents.");
    for (;;) {
      const password = await askPassword({
        title: t("“{name}” is encrypted", { name: basename(archive) }),
        message,
      });
      if (!password) return false;
      const res = await commands.archiveUnlock(archive, password);
      if (res.status === "ok") {
        unlocked.add(archive);
        break;
      }
      message =
        res.error.kind === "io" && res.error.message.includes("password")
          ? t("The password is wrong. Try again.")
          : describeError(res.error);
    }
  }
  return true;
}
