/**
 * Public functions for e2e testing.
 * These expose workflow start/status/signal operations for use from a client.
 */
import { v } from "convex/values";
import {
  getStatus,
  WorkflowId,
  WorkflowManager,
  WorkflowStatus,
  vWorkflowId,
} from "@convex-dev/workflow";
import { mutation, query } from "./_generated/server";
import { components, internal } from "./_generated/api";

const workflow = new WorkflowManager(components.workflow);

// Deterministic action orchestration for CI. The interactive weather example
// still uses Open-Meteo, whose availability must not gate workflow tests.
export const parallelActionsWorkflow = workflow
  .define({
    args: {},
    returns: v.object({
      first: v.string(),
      second: v.string(),
      incremented: v.number(),
    }),
    workpoolOptions: { retryActionsByDefault: true },
  })
  .handler(async (step) => {
    const [first, second] = await Promise.all([
      step.runAction(
        internal.test.oldSyntax.echoAction,
        { msg: "first" },
        { runAfter: 100 },
      ),
      step.runAction(
        internal.test.oldSyntax.echoAction,
        { msg: "second" },
        { retry: true },
      ),
    ]);
    await step.sleep(100, { name: "cooldown" });
    const incremented = await step.runMutation(
      internal.test.oldSyntax.incrementMutation,
      { n: 2 },
    );
    return { first, second, incremented };
  });

// Start various workflows and return their IDs
export const startAll = mutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    parallelActions: WorkflowId;
    catchError: WorkflowId;
    nested: WorkflowId;
    signals: WorkflowId;
    confirmation: WorkflowId;
  }> => {
    const parallelActions = await workflow.start(
      ctx,
      internal.e2e.parallelActionsWorkflow,
      {},
      { startAsync: true },
    );
    const catchError = await workflow.start(
      ctx,
      internal.catchError.catchErrorWorkflow,
      { manualRetries: 2 },
      { startAsync: true },
    );
    const nested = await workflow.start(
      ctx,
      internal.nestedWorkflow.parentWorkflow,
      { prompt: "hello world" },
      { startAsync: true },
    );
    const signals = await workflow.start(
      ctx,
      internal.passingSignals.signalWorkflow,
      {},
      { startAsync: true },
    );
    const confirmation = await workflow.start(
      ctx,
      internal.userConfirmation.confirmationWorkflow,
      { prompt: "test prompt" },
      { startAsync: true },
    );
    return { parallelActions, catchError, nested, signals, confirmation };
  },
});

// Query status of all workflows at once
export const statusAll = query({
  args: {
    ids: v.object({
      parallelActions: vWorkflowId,
      catchError: vWorkflowId,
      nested: vWorkflowId,
      signals: vWorkflowId,
      confirmation: vWorkflowId,
    }),
  },
  handler: async (ctx, { ids }): Promise<Record<string, WorkflowStatus>> => {
    const results: Record<string, WorkflowStatus> = {};
    for (const [name, id] of Object.entries(ids)) {
      results[name] = await getStatus(ctx, components.workflow, id);
    }
    return results;
  },
});

// Approve the confirmation workflow (delegates to the existing chooseProposal mutation)
export const approveConfirmation = mutation({
  args: { workflowId: vWorkflowId },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    await ctx.runMutation(internal.userConfirmation.chooseProposal, {
      workflowId,
      choice: 1,
    });
  },
});
