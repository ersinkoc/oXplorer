import type { AppError_Serialize as AppError, FileEntry_Serialize } from "@/bindings";
import { t } from "@/i18n";

export type { AppError };
export type FileEntry = FileEntry_Serialize;

type Result<T> = { status: "ok"; data: T } | { status: "error"; error: AppError };

/** Thrown by `unwrap` so async callers can use try/catch while keeping the typed payload. */
export class CommandError extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(describeError(error));
    this.name = "CommandError";
    this.error = error;
  }
}

export async function unwrap<T>(pending: Promise<Result<T>>): Promise<T> {
  const result = await pending;
  if (result.status === "error") throw new CommandError(result.error);
  return result.data;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof CommandError) return err.error;
  return { kind: "io", path: null, message: err instanceof Error ? err.message : String(err) };
}

export function describeError(error: AppError): string {
  switch (error.kind) {
    case "notFound":
      return t("“{path}” could not be found.", { path: error.path });
    case "permissionDenied":
      return error.needsFullDiskAccess
        ? t("OXplorer needs Full Disk Access to open “{path}”.", { path: error.path })
        : t("You don’t have permission to open “{path}”.", { path: error.path });
    case "alreadyExists":
      return t("“{path}” already exists.", { path: error.path });
    case "notADirectory":
      return t("“{path}” is not a folder.", { path: error.path });
    case "invalidPath":
      return t("Invalid path “{path}”: {reason}.", { path: error.path, reason: error.reason });
    case "cancelled":
      return t("The operation was cancelled.");
    case "invalidQuery":
      return t("The search pattern isn’t valid: {message}", { message: error.message });
    case "io":
      return error.message;
  }
}
