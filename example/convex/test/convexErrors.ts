import { WorkflowManager } from "@convex-dev/workflow";
import { ConvexError, v, type Value } from "convex/values";
import { components, internal } from "../_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server.js";

const workflow = new WorkflowManager(components.workflow);
const args = { data: v.any() };
const fail = (_ctx: unknown, { data }: { data: Value }): never => {
  throw new ConvexError(data);
};

export const failingQuery = internalQuery({
  args,
  returns: v.null(),
  handler: fail,
});
export const failingMutation = internalMutation({
  args,
  returns: v.null(),
  handler: fail,
});
export const failingAction = internalAction({
  args,
  returns: v.null(),
  handler: fail,
});

export const echo = internalAction({
  args: { isConvexError: v.boolean(), data: v.any() },
  returns: v.object({ isConvexError: v.boolean(), data: v.any() }),
  handler: async (_ctx, args) => args,
});

export const failingWorkflow = workflow
  .define({ args, returns: v.null() })
  .handler(async (_step, { data }) => {
    throw new ConvexError(data);
  });

export const catchingNestedWorkflow = workflow
  .define({
    args,
    returns: v.object({ isConvexError: v.boolean(), data: v.any() }),
  })
  .handler(async (step, { data }) => {
    try {
      await step.runWorkflow(internal.test.convexErrors.failingWorkflow, {
        data,
      });
    } catch (error) {
      return await step.runAction(internal.test.convexErrors.echo, {
        isConvexError: error instanceof ConvexError,
        data: error instanceof ConvexError ? error.data : null,
      });
    }
    throw new Error("Expected the child workflow to fail");
  });

export const catchingWorkflow = workflow
  .define({
    args: {
      data: v.any(),
      functionType: v.union(
        v.literal("query"),
        v.literal("mutation"),
        v.literal("action"),
      ),
      inline: v.boolean(),
    },
    returns: v.object({ isConvexError: v.boolean(), data: v.any() }),
  })
  .handler(async (step, { data, functionType, inline }) => {
    let caught: { isConvexError: boolean; data: Value } = {
      isConvexError: false,
      data: null,
    };
    try {
      switch (functionType) {
        case "query":
          await step.runQuery(
            internal.test.convexErrors.failingQuery,
            { data },
            { inline },
          );
          break;
        case "mutation":
          await step.runMutation(
            internal.test.convexErrors.failingMutation,
            { data },
            { inline },
          );
          break;
        case "action":
          await step.runAction(
            internal.test.convexErrors.failingAction,
            { data },
            { retry: false },
          );
          break;
      }
    } catch (error) {
      caught = {
        isConvexError: error instanceof ConvexError,
        data: error instanceof ConvexError ? error.data : null,
      };
    }
    // A queued recovery step forces replay of the failed step and validates
    // that the caught data stays the same when used in subsequent step args.
    return await step.runAction(internal.test.convexErrors.echo, caught);
  });
