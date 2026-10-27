import type { AppError_Serialize as AppError, FileEntry_Serialize } from "@/bindings";

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
      return `“${error.path}” could not be found.`;
    case "permissionDenied":
      return error.needsFullDiskAccess
        ? `OXplorer needs Full Disk Access to open “${error.path}”.`
        : `You don’t have permission to open “${error.path}”.`;
    case "alreadyExists":
      return `“${error.path}” already exists.`;
    case "notADirectory":
      return `“${error.path}” is not a folder.`;
    case "invalidPath":
      return `Invalid path “${error.path}”: ${error.reason}.`;
    case "cancelled":
      return "The operation was cancelled.";
    case "invalidQuery":
      return `The search pattern isn’t valid: ${error.message}`;
    case "io":
      return error.message;
  }
}
