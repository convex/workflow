import { v } from "convex/values";
import { sendEvent, defineEvent } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api.js";
import { internalAction, internalMutation } from "./_generated/server.js";
import { vWorkflowId } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";
import { workflow } from "./example.js";

// Action that returns a value larger than 800KB.
export const largeReturnAction = internalAction({
  args: {},
  returns: v.string(),
  handler: async (): Promise<string> => {
    return "x".repeat(900_000);
  },
});

export const largeReturnWorkflow = workflow
  .define({
    args: {},
  })
  .handler(async (step) => {
    const result = await step.runAction(
      internal.oversized.largeReturnAction,
      {},
    );
    return result;
  });

export const overStorageLimitAction = internalAction({
  args: {},
  returns: v.string(),
  // Escaping NUL characters produces an 18 MB JSON blob.
  handler: async (): Promise<string> => "\0".repeat(3_000_000),
});

export const overStorageLimitWorkflow = workflow
  .define({ args: {} })
  .handler(async (step) => {
    return await step.runAction(internal.oversized.overStorageLimitAction, {});
  });

export const bigEvent = defineEvent({
  name: "bigEvent",
  validator: v.string(),
});

export const eventWorkflow = workflow
  .define({
    args: {},
  })
  .handler(async (step) => {
    const result = await step.awaitEvent(bigEvent);
    return result;
  });

export const eventBatchWorkflow = workflow
  .define({ args: {} })
  .handler(async (step) => {
    await Promise.all(
      Array.from({ length: 11 }, (_, i) =>
        step.awaitEvent({ name: `batch-${i}` }),
      ),
    );
  });

export const sendEventBatch = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, { workflowId }) => {
    for (let i = 0; i < 11; i++) {
      await sendEvent(ctx, components.workflow, {
        workflowId,
        name: `batch-${i}`,
        value: "z".repeat(900_000),
      });
    }
  },
});

export const sendBigEvent = internalMutation({
  args: {
    workflowId: vWorkflowId,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await sendEvent(ctx, components.workflow, {
      ...bigEvent,
      workflowId: args.workflowId,
      value: "y".repeat(900_000),
    });
  },
});

export const onComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const flow = await ctx.db
      .query("flows")
      .withIndex("workflowId", (q) => q.eq("workflowId", args.workflowId))
      .first();
    if (!flow) return null;
    await ctx.db.patch("flows", flow._id, { out: args.result });
    return null;
  },
});
