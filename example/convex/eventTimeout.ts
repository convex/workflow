import {
  defineEvent,
  type EventId,
  vEventId,
  vWorkflowId,
  WorkflowManager,
  type WorkflowId,
} from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const workflow = new WorkflowManager(components.workflow, {
  internalMutation,
});

const approvalEvent = defineEvent({
  name: "approval",
  validator: v.union(
    v.object({ kind: v.literal("approved") }),
    v.object({ kind: v.literal("timeout") }),
  ),
});

/**
 * A workflow that waits for an approval event but times out after 30 seconds.
 *
 * It uses `step.run()` to schedule a timeout function via `ctx.scheduler`,
 * then awaits the event. If the event resolves with a real approval, the
 * timeout function is canceled. If the timeout fires first, the workflow
 * handles it gracefully.
 */
export const eventTimeoutWorkflow = workflow.define({
  args: {},
  returns: v.string(),
  handler: async (step): Promise<string> => {
    // 1. Create the event so we have an ID to pass to the timeout function.
    const eventId = await step.runMutation(
      internal.eventTimeout.createApprovalEvent,
      { workflowId: step.workflowId },
    );

    // 2. Schedule a function that will complete the event with { kind: "timeout" }
    //    after 30 seconds, unless it's canceled first.
    const scheduledFnId = await step.run(
      async (ctx) => {
        return ctx.scheduler.runAfter(
          30_000,
          internal.eventTimeout.timeoutEvent,
          { eventId },
        );
      },
      { name: "scheduleTimeout" },
    );

    // 3. Wait for the event — either a real approval or the timeout.
    const result = await step.awaitEvent({ ...approvalEvent, id: eventId });

    // 4. If we got a real approval, cancel the scheduled timeout function.
    if (result.kind === "approved") {
      await step.run(
        async (ctx) => {
          const scheduled = await ctx.db.system.get(scheduledFnId);
          if (scheduled?.state.kind === "pending")
            await ctx.scheduler.cancel(scheduledFnId);
        },
        { name: "cancelTimeout" },
      );
      return "approved";
    }

    return "timed out";
  },
});

// ── Helper mutations ──────────────────────────

export const createApprovalEvent = internalMutation({
  args: { workflowId: vWorkflowId },
  returns: vEventId("approval"),
  handler: async (ctx, args): Promise<EventId<"approval">> => {
    return await workflow.createEvent(ctx, {
      name: "approval",
      workflowId: args.workflowId,
    });
  },
});

export const timeoutEvent = internalMutation({
  args: { eventId: vEventId("approval") },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      ...approvalEvent,
      id: args.eventId,
      value: { kind: "timeout" },
    });
  },
});

export const approve = internalMutation({
  args: { eventId: vEventId("approval") },
  handler: async (ctx, args) => {
    await workflow.sendEvent(ctx, {
      ...approvalEvent,
      id: args.eventId,
      value: { kind: "approved" },
    });
  },
});

/**
 * Test this from the CLI:
 * ```sh
 * npx convex run eventTimeout:startEventTimeout
 * ```
 * Then either approve before 30s:
 * ```sh
 * npx convex run eventTimeout:approve '{"eventId":"..."}'
 * ```
 * Or wait 30s for the timeout to fire automatically.
 */
export const startEventTimeout = internalMutation({
  args: {},
  handler: async (ctx): Promise<WorkflowId> => {
    return await workflow.start(
      ctx,
      internal.eventTimeout.eventTimeoutWorkflow,
      {},
    );
  },
});
