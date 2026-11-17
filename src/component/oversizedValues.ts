import { type Value, convexToJson, getConvexSize } from "convex/values";
import type { RunResult } from "@convex-dev/workpool";

export const MAX_RETURN_VALUE_SIZE = 800 << 10;
const PREVIEW_SIZE = 8 << 10;

function truncatedPreview(returnValue: unknown): string {
  const json = JSON.stringify(convexToJson(returnValue as Value));
  if (json.length <= PREVIEW_SIZE * 2) {
    return json;
  }
  return json.slice(0, PREVIEW_SIZE) + "..." + json.slice(-PREVIEW_SIZE);
}

export function checkReturnValueSize(
  returnValue: Value | undefined,
): string | null {
  const size = getConvexSize(returnValue);
  if (size > MAX_RETURN_VALUE_SIZE) {
    return `Step return value too large (${size} bytes). Maximum is ${MAX_RETURN_VALUE_SIZE} bytes. Preview: ${truncatedPreview(returnValue)}`;
  }
  return null;
}

export function checkForOversizedResult<Result extends RunResult>(
  result: Result,
): Result | Extract<RunResult, { kind: "failed" }> {
  if (result.kind === "failed") {
    // Count the whole failure: the message/stack may duplicate the error data.
    const size = getConvexSize(result);
    if (size > MAX_RETURN_VALUE_SIZE) {
      return {
        kind: "failed",
        error: `Step failure too large (${size} bytes). Maximum is ${MAX_RETURN_VALUE_SIZE} bytes. Original error data omitted. Preview: ${truncatedPreview(result.error)}`,
      };
    }
    return result;
  }
  if (result.kind !== "success") {
    return result;
  }
  const sizeError = checkReturnValueSize(result.returnValue as Value);
  if (!sizeError) {
    return result;
  }
  return { kind: "failed", error: sizeError };
}
