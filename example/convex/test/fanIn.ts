import { WorkflowManager } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "../_generated/api.js";
import { internalMutation } from "../_generated/server.js";

export const workflow = new WorkflowManager(components.workflow);

// Counts handler invocations (including replays), so tests can observe
// redundant replays. Only meaningful in convex-test, where modules are shared.
export const handlerRuns = { count: 0 };

export const noop = internalMutation({
  args: {},
  returns: v.null(),
  handler: async () => null,
});

// Many steps complete together, then the handler fails or succeeds.
export const fanIn = workflow
  .define({
    args: { width: v.number(), fail: v.boolean() },
    returns: v.number(),
  })
  .handler(async (step, args): Promise<number> => {
    handlerRuns.count++;
    await Promise.all(
      Array.from({ length: args.width }, () =>
        step.runMutation(internal.test.fanIn.noop, {}),
      ),
    );
    if (args.fail) {
      throw new Error("boom");
    }
    return args.width;
  });
