import { getStatus, WorkflowManager } from "@convex-dev/workflow";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { components, internal } from "../_generated/api.js";
import { initConvexTest } from "../setup.test.js";
import { getConvexSize, type Value } from "convex/values";

const workflow = new WorkflowManager(components.workflow);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each([
  { functionType: "query" as const, inline: true },
  { functionType: "mutation" as const, inline: true },
  { functionType: "query" as const, inline: false },
  { functionType: "mutation" as const, inline: false },
  { functionType: "action" as const, inline: false },
])(
  "preserves ConvexError from $functionType (inline: $inline) through replay",
  async (options) => {
    const t = initConvexTest();
    const data = {
      code: "INVALID_INPUT",
      message: "Please try again",
      count: 7,
    };
    const workflowId = await t.mutation((ctx) =>
      workflow.start(ctx, internal.test.convexErrors.catchingWorkflow, {
        ...options,
        data,
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status).toEqual({
      type: "completed",
      result: { isConvexError: true, data },
    });
  },
);

test("preserves an uncaught ConvexError from a nested workflow", async () => {
  const t = initConvexTest();
  const data = { code: "CHILD_FAILED", message: "Please try again" };
  const workflowId = await t.mutation((ctx) =>
    workflow.start(ctx, internal.test.convexErrors.catchingNestedWorkflow, {
      data,
    }),
  );
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    await t.query((ctx) => getStatus(ctx, components.workflow, workflowId)),
  ).toEqual({
    type: "completed",
    result: { isConvexError: true, data },
  });
});

test.each(["query", "mutation"] as const)(
  "oversized inline %s failures remain catchable through replay",
  async (functionType) => {
    const t = initConvexTest();
    const workflowId = await t.mutation((ctx) =>
      workflow.start(ctx, internal.test.convexErrors.catchingOversizedError, {
        functionType,
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    if (status.type !== "completed")
      throw new Error("Expected recovery to complete");
    expect(status.result).toMatchObject({
      isConvexError: false,
      data: expect.stringContaining("Step failure too large"),
    });
    expect(getConvexSize(status.result as Value)).toBeLessThan(100 << 10);
    const steps = await t.query((ctx) =>
      workflow.listSteps(ctx, workflowId, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    );
    expect(steps.page).toHaveLength(2);
    const failure = steps.page[0].runResult;
    expect(failure).toMatchObject({ kind: "failed" });
    if (failure?.kind !== "failed")
      throw new Error("Expected a recorded failure");
    expect(failure).not.toHaveProperty("errorData");
    expect(getConvexSize(failure)).toBeLessThan(100 << 10);
  },
);
