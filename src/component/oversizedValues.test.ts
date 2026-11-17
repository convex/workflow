import { ConvexError, getConvexSize, type Value } from "convex/values";
import { expect, test } from "vitest";
import { failedResult } from "../shared.js";
import {
  checkForOversizedResult,
  MAX_RETURN_VALUE_SIZE,
} from "./oversizedValues.js";

test.each<Value>([null, false, 0, "", { code: "INVALID", count: 7n }])(
  "preserves small structured failures: %s",
  (errorData) => {
    const result = {
      kind: "failed" as const,
      error: "server stack",
      errorData,
    };
    expect(checkForOversizedResult(result)).toBe(result);
  },
);

test.each([
  { error: "server stack", errorData: "x".repeat(MAX_RETURN_VALUE_SIZE) },
  {
    error: "x".repeat(MAX_RETURN_VALUE_SIZE / 2),
    errorData: "y".repeat(MAX_RETURN_VALUE_SIZE / 2),
  },
  { error: "x".repeat(MAX_RETURN_VALUE_SIZE), errorData: null },
])("bounds the entire failed result before recording it", (failure) => {
  const result = checkForOversizedResult({ kind: "failed", ...failure });
  expect(result).toMatchObject({ kind: "failed" });
  expect(result.error).toContain("Step failure too large");
  expect(result).not.toHaveProperty("errorData");
  expect(getConvexSize(result)).toBeLessThan(100 << 10);
});

test("accepts the failure size limit and rejects the next byte", () => {
  const overhead = getConvexSize({ kind: "failed", error: "" });
  const result = {
    kind: "failed" as const,
    error: "x".repeat(MAX_RETURN_VALUE_SIZE - overhead),
  };
  expect(getConvexSize(result)).toBe(MAX_RETURN_VALUE_SIZE);
  expect(checkForOversizedResult(result)).toBe(result);
  expect(
    checkForOversizedResult({ ...result, error: result.error + "x" }).error,
  ).toContain("Step failure too large");
});

test("bounds ConvexError data and its formatted message before crossing into the component", () => {
  const result = failedResult(new ConvexError("x".repeat(2 << 20)));
  expect(result.error).toContain("Step failure too large");
  expect(result).not.toHaveProperty("errorData");
  expect(getConvexSize(result)).toBeLessThan(100 << 10);
});
