import { toast } from "sonner";
import { commands, type JobSpec } from "@/bindings";
import { t } from "@/i18n";
import { isArchivePath } from "@/lib/archive-path";
import { unwrap } from "@/lib/ipc";
import { isRemotePath } from "@/lib/remote-path";
import { isSearchPath } from "@/lib/search-path";

/**
 * A real file for an item that may live inside an archive or on a server
 * (extracted / downloaded to a private temporary folder), e.g. to open it.
 */
export async function materialize(path: string): Promise<string> {
  if (isArchivePath(path)) return unwrap(commands.archiveOpenMember(path));
  if (isRemotePath(path)) return unwrap(commands.remoteOpenMember(path));
  return path;
}

/**
 * The job that brings `sources` into `destDir`, wherever either side is:
 * out of an archive, down from or up to a server, or a plain copy/move.
 * Returns null (after saying why) for combinations that aren't supported.
 */
export function transferSpec(sources: string[], destDir: string, local: "copy" | "move"): JobSpec | null {
  if (isArchivePath(destDir) || isSearchPath(destDir)) {
    toast(t("Items can’t be added here. Open a folder or a server to put them in."));
    return null;
  }
  const fromArchive = sources.some(isArchivePath);
  const fromRemote = sources.some(isRemotePath);
  const toRemote = isRemotePath(destDir);
  if ((fromArchive || fromRemote) && toRemote) {
    toast(t("Copy the items to a folder on this Mac first, then to the server."));
    return null;
  }
  if (fromArchive) return { kind: "extractMembers", sources, destDir };
  if (fromRemote) return { kind: "download", sources, destDir };
  if (toRemote) return { kind: "upload", sources, destDir };
  return { kind: local, sources, destDir };
}
