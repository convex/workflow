import { getStatus, WorkflowManager } from "@convex-dev/workflow";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { components, internal } from "../_generated/api.js";
import { initConvexTest } from "../setup.test.js";

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
