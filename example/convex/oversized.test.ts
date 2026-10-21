/// <reference types="vite/client" />

import { expect, describe, test, vi, beforeEach, afterEach } from "vitest";
import { initConvexTest } from "./setup.test";
import { components, internal } from "./_generated/api";
import { assert } from "convex-helpers";
import { getStatus } from "@convex-dev/workflow";
import { workflow } from "./example";

describe("oversized values", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("large step return value fails workflow and calls onComplete", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(async (ctx) => {
      const wfId = await workflow.start(
        ctx,
        internal.oversized.largeReturnWorkflow,
        {},
        {
          onComplete: internal.oversized.onComplete,
          context: {},
          startAsync: true,
        },
      );
      await ctx.db.insert("flows", {
        workflowId: wfId,
        in: "largeReturn",
        out: null,
      });
      return wfId;
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("failed");
    assert(status.type === "failed");
    expect(status.error).toContain("Step return value too large");

    const flow = await t.query(async (ctx) => {
      return ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
        .first();
    });
    expect(flow).not.toBeNull();
    assert(flow);
    expect(flow.out).not.toBeNull();
    expect(flow.out.kind).toBe("failed");
    expect(flow.out.error).toContain("Step return value too large");

    const { page } = await t.query(components.workflow.oversizedValues.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(page).toHaveLength(1);
    const { stepId } = page[0];
    expect(
      await t.mutation(components.workflow.oversizedValues.read, { stepId }),
    ).toBe("x".repeat(900_000));
    await t.mutation(components.workflow.oversizedValues.remove, { stepId });
    await expect(
      t.mutation(components.workflow.oversizedValues.read, { stepId }),
    ).rejects.toThrow("No oversized value found");
    await t.mutation(components.workflow.oversizedValues.remove, { stepId });
  });

  test("large event value fails workflow and calls onComplete", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(async (ctx) => {
      const wfId = await workflow.start(
        ctx,
        internal.oversized.eventWorkflow,
        {},
        {
          onComplete: internal.oversized.onComplete,
          context: {},
          startAsync: true,
        },
      );
      await ctx.db.insert("flows", {
        workflowId: wfId,
        in: "eventWorkflow",
        out: null,
      });
      return wfId;
    });
    // Let the workflow start and reach the awaitEvent point
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("inProgress");

    // Send the oversized event
    await t.mutation(internal.oversized.sendBigEvent, { workflowId });
    // The value must be available before any scheduled functions run.
    const { page } = await t.query(components.workflow.oversizedValues.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(page).toHaveLength(1);
    const { stepId } = page[0];
    expect(
      await t.mutation(components.workflow.oversizedValues.read, { stepId }),
    ).toBe("y".repeat(900_000));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status2 = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status2.type).toBe("failed");
    assert(status2.type === "failed");
    expect(status2.error).toContain("Step return value too large");
    expect(status2.error).toContain("900002 bytes");

    const flow = await t.query(async (ctx) => {
      return ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", workflowId))
        .first();
    });
    expect(flow).not.toBeNull();
    expect(flow!.out).not.toBeNull();
    expect(flow!.out.kind).toBe("failed");
    expect(flow!.out.error).toContain("Step return value too large");

    expect(
      await t.mutation(components.workflow.workflow.cleanup, { workflowId }),
    ).toBe(true);
    await expect(
      t.mutation(components.workflow.oversizedValues.read, { stepId }),
    ).rejects.toThrow("No oversized value found");
  });

  test("stores an oversized event sent before the workflow awaits it", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(async (ctx) => {
      const id = await workflow.start(
        ctx,
        internal.oversized.eventWorkflow,
        {},
        {
          startAsync: true,
        },
      );
      await ctx.runMutation(internal.oversized.sendBigEvent, {
        workflowId: id,
      });
      return id;
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("failed");
    const { page } = await t.query(components.workflow.oversizedValues.list, {
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(page).toHaveLength(1);
    expect(
      await t.mutation(components.workflow.oversizedValues.read, {
        stepId: page[0].stepId,
      }),
    ).toBe("y".repeat(900_000));
  });
});
