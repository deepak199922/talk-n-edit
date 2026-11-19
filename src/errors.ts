export type ErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PATH_DENIED"
  | "DEPENDENCY_MISSING"
  | "ENGINE_FAILED"
  | "LIMIT_EXCEEDED"
  | "BUSY"
  | "CANCELLED";

export class StudioError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public hint?: string,
    public path?: string,
  ) {
    super(message);
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, path: this.path };
  }
}

export function asStudioError(e: unknown): StudioError {
  if (e instanceof StudioError) return e;
  const err = e as Error;
  return new StudioError("ENGINE_FAILED", err?.message ?? String(e));
}
