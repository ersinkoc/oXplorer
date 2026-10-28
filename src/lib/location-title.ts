import type { Connection } from "@/bindings";
import { archiveTitle, parseArchivePath } from "@/lib/archive-path";
import { basename } from "@/lib/path";
import { isRemotePath, remoteTitle } from "@/lib/remote-path";
import { parseSearchPath, searchTitle } from "@/lib/search-path";

/** What a tab or sidebar item calls a location: folder name, search, archive or server. */
export function locationTitle(path: string, connections: readonly Connection[]): string {
  const search = parseSearchPath(path);
  if (search) return searchTitle(search);
  if (parseArchivePath(path)) return archiveTitle(path);
  if (isRemotePath(path)) return remoteTitle(path, connections);
  return path === "/" ? "Macintosh HD" : basename(path);
}
