import { FolderOpen, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { commands } from "@/bindings";
import { reload } from "@/commands/navigation";
import { type AppError, describeError, type FileEntry } from "@/lib/ipc";
import type { DirState } from "@/stores/dir-cache-store";

/** What to show instead of items, or `null` when there are items to render. */
export function statusBody(
  dir: DirState | undefined,
  entries: readonly FileEntry[],
  filtered: boolean,
): ReactNode {
  const status = dir?.status ?? "loading";
  if (status === "error" && dir?.error) return <ErrorState error={dir.error} />;
  if (entries.length > 0) return null;
  return status === "loading" ? <LoadingState /> : <EmptyState filtered={filtered} />;
}

function LoadingState() {
  // Fast folders shouldn't flash a spinner.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <Centered>
      <Loader2 className="size-5 animate-spin text-fg-muted" />
    </Centered>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <Centered>
      <FolderOpen className="size-10 text-fg-faint" strokeWidth={1.25} />
      <p className="text-fg-muted">{filtered ? "No items match the filter" : "This folder is empty"}</p>
    </Centered>
  );
}

function ErrorState({ error }: { error: AppError }) {
  const needsFda = error.kind === "permissionDenied" && error.needsFullDiskAccess;
  const Icon = error.kind === "permissionDenied" ? ShieldAlert : TriangleAlert;
  return (
    <Centered>
      <Icon className="size-10 text-fg-faint" strokeWidth={1.25} />
      <p className="max-w-md text-center text-fg-muted">{describeError(error)}</p>
      <div className="flex gap-2">
        {needsFda && (
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1 text-white"
            onClick={() => void commands.openFullDiskAccessSettings()}
          >
            Grant Full Disk Access
          </button>
        )}
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1 hover:bg-hover"
          onClick={reload}
        >
          Try Again
        </button>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6">{children}</div>;
}
