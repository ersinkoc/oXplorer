/**
 * Folders on a server: `remote:<connection id>/<path>` (path without a
 * leading slash; empty at the connection's top).
 */
const PREFIX = "remote:";

export function isRemotePath(path: string): boolean {
  return path.startsWith(PREFIX);
}

export function remotePath(id: string, inner = ""): string {
  return `${PREFIX}${id}/${inner}`;
}

export function parseRemotePath(path: string): { id: string; inner: string } | null {
  if (!isRemotePath(path)) return null;
  const rest = path.slice(PREFIX.length);
  const slash = rest.indexOf("/");
  const id = slash < 0 ? rest : rest.slice(0, slash);
  if (!id) return null;
  const inner = slash < 0 ? "" : rest.slice(slash + 1).replace(/^\/+|\/+$/g, "");
  return { id, inner };
}

/** The folder above, with the item we came from (null at the connection's top). */
export function remoteParent(path: string): { path: string; select: string } | null {
  const p = parseRemotePath(path);
  if (!p?.inner) return null;
  const up = p.inner.includes("/") ? p.inner.slice(0, p.inner.lastIndexOf("/")) : "";
  return { path: remotePath(p.id, up), select: path };
}

/** Connection name (or its folder's name) for tabs and the path bar. */
export function remoteTitle(path: string, connections: readonly { id: string; name: string }[]): string {
  const p = parseRemotePath(path);
  if (!p) return path;
  if (p.inner) return p.inner.slice(p.inner.lastIndexOf("/") + 1);
  return connections.find((c) => c.id === p.id)?.name ?? p.id;
}

/** The remote folder that contains `path` (for an item inside it). */
export function remoteDirOf(path: string): string {
  return remoteParent(path)?.path ?? path;
}
