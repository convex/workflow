import { sendEvent, vWorkflowId, WorkflowManager } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "../_generated/api.js";
import { internalAction, internalMutation } from "../_generated/server.js";

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

export const alwaysFails = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    throw new Error("always fails");
  },
});

export const sendSelf = internalMutation({
  args: { workflowId: vWorkflowId },
  returns: v.null(),
  handler: async (ctx, args) => {
    await sendEvent(ctx, components.workflow, {
      workflowId: args.workflowId,
      name: "ready",
    });
    return null;
  },
});

// One branch fails (after a retry) while the other sends itself an event and
// then waits for it. On the replay after the failure, the handler finishes
// while the second branch is still asking for its wait step.
export const failBesideEvent = workflow
  .define({ args: {} })
  .handler(async (step): Promise<void> => {
    await Promise.all([
      step.runAction(
        internal.test.fanIn.alwaysFails,
        {},
        { retry: { maxAttempts: 2, initialBackoffMs: 10, base: 1 } },
      ),
      (async () => {
        await step.runMutation(internal.test.fanIn.sendSelf, {
          workflowId: step.workflowId,
        });
        await step.awaitEvent({ name: "ready" });
      })(),
    ]);
  });
