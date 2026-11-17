import { ConvexError } from "convex/values";
import type { RunResult } from "./client/types.js";
import { checkForOversizedResult } from "./component/oversizedValues.js";

export const MAX_JOURNAL_SIZE = 8 << 20;

export function failedResult(
  error: unknown,
): Extract<RunResult, { kind: "failed" }> {
  return checkForOversizedResult({
    kind: "failed",
    error: formatErrorWithStack(error),
    ...(error instanceof ConvexError ? { errorData: error.data ?? null } : {}),
  });
}

export function formatErrorWithStack(error: unknown): string {
  if (error instanceof Error) {
    return error.toString() + (error.stack ? "\n" + error.stack : "");
  }
  return String(error);
}
