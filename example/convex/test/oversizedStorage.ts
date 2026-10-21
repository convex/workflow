// Live smoke test for the prerelease storage-in-mutations API:
// npx convex run test/oversizedStorage:run
import { v } from "convex/values";
import { getStatus, vWorkflowId } from "@convex-dev/workflow";
import type { WorkflowId, WorkflowStatus } from "@convex-dev/workflow";
import { assert } from "convex-helpers";
import { components, internal } from "../_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server.js";
import { workflow } from "../example.js";

export const start = internalMutation({
  args: { event: v.boolean(), early: v.boolean() },
  handler: async (ctx, args): Promise<WorkflowId> => {
    const workflowId = await workflow.start(
      ctx,
      args.event
        ? internal.oversized.eventWorkflow
        : internal.oversized.largeReturnWorkflow,
      {},
      { startAsync: true },
    );
    if (args.early) {
      await ctx.runMutation(internal.oversized.sendBigEvent, { workflowId });
    }
    return workflowId;
  },
});

export const status = internalQuery({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args): Promise<WorkflowStatus> =>
    getStatus(ctx, components.workflow, args.workflowId),
});

export const sendAndRollback = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.oversized.sendBigEvent, args);
    throw new Error("Intentional rollback after storing an oversized event");
  },
});

export const inspect = internalMutation({
  args: {
    workflowId: vWorkflowId,
    expected: v.string(),
    verifyRead: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<string> => {
    const { page } = await ctx.runQuery(
      components.workflow.oversizedValues.list,
      {
        paginationOpts: { cursor: null, numItems: 100 },
      },
    );
    const records = page.filter((r) => r.workflowId === args.workflowId);
    assert(
      records.length === 1,
      `Expected one stored value, got ${records.length}`,
    );
    const record = records[0];
    if (args.verifyRead === false) return record.stepId;
    const value = await ctx.runMutation(
      components.workflow.oversizedValues.read,
      {
        stepId: record.stepId,
      },
    );
    assert(value === args.expected.repeat(900_000), "Stored value differs");
    return record.stepId;
  },
});

export const remove = internalMutation({
  args: { stepId: v.string(), rollback: v.boolean() },
  handler: async (ctx, args) => {
    await ctx.runMutation(components.workflow.oversizedValues.remove, {
      stepId: args.stepId,
    });
    if (args.rollback)
      throw new Error("Intentional rollback after removing a value");
  },
});

export const cleanup = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args): Promise<boolean> =>
    ctx.runMutation(components.workflow.workflow.cleanup, args),
});

export const assertMissing = internalMutation({
  args: { stepId: v.string() },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(components.workflow.oversizedValues.read, args);
    } catch (error) {
      if (String(error).includes("No oversized value found")) return;
      throw error;
    }
    throw new Error("Value was still available after deletion");
  },
});

export const run = internalAction({
  args: { verifyReads: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<string[]> => {
    const passed: string[] = [];
    for (const mode of ["action", "waiting event", "early event"]) {
      const event = mode !== "action";
      const early = mode === "early event";
      const workflowId = await ctx.runMutation(
        internal.test.oversizedStorage.start,
        {
          event,
          early,
        },
      );
      try {
        if (event && !early) {
          // Starting asynchronously needs time to reach awaitEvent.
          let waiting = false;
          for (let i = 0; i < 100; i++) {
            const state = await ctx.runQuery(
              internal.test.oversizedStorage.status,
              { workflowId },
            );
            if (
              state.type === "inProgress" &&
              state.running.some((s) => s.kind === "event")
            ) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert(waiting, "Workflow did not reach awaitEvent");
          try {
            await ctx.runMutation(
              internal.test.oversizedStorage.sendAndRollback,
              { workflowId },
            );
            throw new Error("Expected rollback");
          } catch (error) {
            assert(
              String(error).includes("Intentional rollback"),
              String(error),
            );
          }
          await ctx.runMutation(internal.oversized.sendBigEvent, {
            workflowId,
          });
        }
        let failed = false;
        for (let i = 0; i < 100; i++) {
          const state = await ctx.runQuery(
            internal.test.oversizedStorage.status,
            { workflowId },
          );
          if (state.type === "failed") {
            assert(
              state.error.includes("Step return value too large"),
              state.error,
            );
            failed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert(failed, `${mode}: workflow did not fail as expected`);
        const expected = event ? "y" : "x";
        const stepId = await ctx.runMutation(
          internal.test.oversizedStorage.inspect,
          { workflowId, expected, verifyRead: args.verifyReads },
        );
        try {
          await ctx.runMutation(internal.test.oversizedStorage.remove, {
            stepId,
            rollback: true,
          });
          throw new Error("Expected rollback");
        } catch (error) {
          assert(String(error).includes("Intentional rollback"), String(error));
        }
        // Both the record and blob must survive the rolled-back removal.
        await ctx.runMutation(internal.test.oversizedStorage.inspect, {
          workflowId,
          expected,
          verifyRead: args.verifyReads,
        });
        if (mode === "action") {
          await ctx.runMutation(internal.test.oversizedStorage.remove, {
            stepId,
            rollback: false,
          });
          await ctx.runMutation(internal.test.oversizedStorage.assertMissing, {
            stepId,
          });
          // Removing twice is harmless.
          await ctx.runMutation(internal.test.oversizedStorage.remove, {
            stepId,
            rollback: false,
          });
        }
        assert(
          await ctx.runMutation(internal.test.oversizedStorage.cleanup, {
            workflowId,
          }),
          "Cleanup failed",
        );
        await ctx.runMutation(internal.test.oversizedStorage.assertMissing, {
          stepId,
        });
        passed.push(
          args.verifyReads === false
            ? `${mode}: metadata, rollback, removal, cleanup (blob reads skipped)`
            : mode,
        );
      } finally {
        await ctx.runMutation(internal.test.oversizedStorage.cleanup, {
          workflowId,
        });
      }
    }
    return passed;
  },
});
