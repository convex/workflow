import {
  vResultValidator,
  vRetryBehavior,
  vWorkIdValidator,
  Workpool,
  type RunResult,
  type WorkId,
  type WorkpoolOptions,
} from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { validate } from "convex-helpers/validators";
import {
  type FunctionHandle,
  type FunctionReference_future,
  type RegisteredAction,
} from "convex/server";
import { type Infer, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { logLevel } from "./logging.js";
import { getDefaultLogger } from "./utils.js";
import { completeHandler } from "./workflow.js";
import type { Doc } from "./_generated/dataModel.js";
import { vWorkflowId, type WorkflowId } from "../types.js";
import { checkForOversizedResult } from "./oversizedValues.js";

export const workpoolOptions = v.object({
  logLevel: v.optional(logLevel),
  maxParallelism: v.optional(v.number()),
  defaultRetryBehavior: v.optional(vRetryBehavior),
  retryActionsByDefault: v.optional(v.boolean()),
});
// type check
const _: WorkpoolOptions = {} as Infer<typeof workpoolOptions>;

export const DEFAULT_MAX_PARALLELISM = 25;
export const DEFAULT_RETRY_BEHAVIOR = {
  maxAttempts: 5,
  initialBackoffMs: 500,
  base: 2,
};

export async function getWorkpool(
  ctx: MutationCtx,
  opts: WorkpoolOptions | undefined,
) {
  // nit: can fetch config only if necessary
  const config = await ctx.db.query("config").first();
  const logLevel = opts?.logLevel ?? config?.logLevel;
  const maxParallelism =
    opts?.maxParallelism ?? config?.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
  return new Workpool(components.workpool, {
    logLevel,
    maxParallelism,
    defaultRetryBehavior: opts?.defaultRetryBehavior ?? DEFAULT_RETRY_BEHAVIOR,
    retryActionsByDefault: opts?.retryActionsByDefault ?? false,
  });
}

const onCompleteContext = v.object({
  generationNumber: v.number(),
  stepId: v.id("steps"),
  workpoolOptions: v.optional(workpoolOptions),
});

export type OnCompleteContext = Infer<typeof onCompleteContext>;

// For a single step
export const onComplete = internalMutation({
  args: {
    workId: vWorkIdValidator,
    result: vResultValidator,
    context: v.any(), // Ensure we can catch invalid context to fail workflow.
  },
  returns: v.null(),
  handler: onCompleteHandler,
});

// For a nested workflow
export const nestedWorkflowOnComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: onCompleteHandler,
});

async function onCompleteHandler(
  ctx: MutationCtx,
  args: {
    workId?: WorkId;
    workflowId?: WorkflowId;
    result: RunResult;
    context: object;
  },
) {
  const console = await getDefaultLogger(ctx);
  const stepId =
    "stepId" in args.context && typeof args.context.stepId === "string"
      ? ctx.db.normalizeId("steps", args.context.stepId)
      : null;
  if (!stepId) {
    // Write to failures table and return
    // So someone can investigate if this ever happens
    console.error("Invalid onComplete context", args.context);
    await ctx.db.insert("onCompleteFailures", args);
    return;
  }
  const journalEntry = await ctx.db.get("steps", stepId);
  if (!journalEntry) {
    console.error(
      `Journal entry not found: ${stepId}. This is likely because it was already cleaned up.`,
    );
    return;
  }
  const workflowId = journalEntry.workflowId;

  if (
    !validate(onCompleteContext, args.context, { allowUnknownFields: true })
  ) {
    const error =
      `Invalid onComplete context for ${args.workId ? `workId ${args.workId}` : `nested workflowId ${args.workflowId}`}` +
      JSON.stringify(args.context);
    await ctx.db.patch("workflows", workflowId, {
      runResult: {
        kind: "failed",
        error,
      },
    });
    return;
  }
  const { generationNumber } = args.context;
  const workflow = await ctx.db.get("workflows", workflowId);
  assert(workflow, `Workflow not found: ${workflowId}`);
  if (workflow.generationNumber !== generationNumber) {
    console.error(
      `Workflow: ${workflowId} already has generation number ${workflow.generationNumber} when completing ${stepId}. Expected ${generationNumber}`,
    );
    return;
  }
  if (!journalEntry.step.inProgress) {
    console.error(
      `Step finished but journal entry not in progress: ${stepId} status: ${journalEntry.step.runResult?.kind ?? "pending"}`,
    );
    return;
  }
  journalEntry.step.inProgress = false;
  journalEntry.step.completedAt = Date.now();
  const runResult = await checkForOversizedResult(
    ctx,
    args.result,
    { stepId },
  );
  journalEntry.step.runResult = runResult;
  await ctx.db.replace("steps", journalEntry._id, journalEntry);
  console.debug(`Completed execution of ${stepId}`, journalEntry);

  console.event("stepCompleted", {
    workflowId,
    workflowName: workflow.name,
    status: journalEntry.step.runResult.kind,
    stepName: journalEntry.step.name,
    stepNumber: journalEntry.stepNumber,
    durationMs: journalEntry.step.completedAt - journalEntry.step.startedAt,
  });
  if (workflow.runResult !== undefined) {
    if (workflow.runResult.kind !== "canceled") {
      console.error(
        `Workflow: ${workflowId} already ${workflow.runResult.kind} when completing ${stepId} with status ${journalEntry.step.runResult.kind}`,
      );
    }
    return;
  }
  const workpool = await getWorkpool(ctx, args.context.workpoolOptions);
  await enqueueWorkflow(ctx, workflow, workpool);
}

export async function enqueueWorkflow(
  ctx: MutationCtx,
  workflow: Doc<"workflows">,
  workpool: Workpool,
) {
  const { _id: workflowId, generationNumber, name, workflowHandle } = workflow;
  await workpool.enqueueMutation(
    ctx,
    workflowHandle as FunctionHandle<"mutation">,
    { workflowId, generationNumber },
    {
      name,
      onComplete: internal.pool.handlerOnComplete,
      onCompleteExcludeKinds: ["success"],
      context: { workflowId, generationNumber },
    },
  );
}

export type OnComplete =
  typeof onComplete extends RegisteredAction<
    "public",
    infer Args,
    infer ReturnValue
  >
    ? FunctionReference_future<"action", "internal", Args, ReturnValue>
    : never;

const handlerOnCompleteContext = v.object({
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
});

// For the workflow handler
export const handlerOnComplete = internalMutation({
  args: {
    workId: vWorkIdValidator,
    result: vResultValidator,
    context: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.result.kind === "success") {
      return;
    }
    const console = await getDefaultLogger(ctx);
    if (!validate(handlerOnCompleteContext, args.context)) {
      console.error("Invalid handlerOnComplete context", args.context);
      const workflowId = ctx.db.normalizeId(
        "workflows",
        args.context.workflowId,
      );
      await ctx.db.insert("onCompleteFailures", args);
      if (!workflowId) {
        console.error("Invalid workflow ID", args.context.workflowId);
        return;
      }
      await completeHandler(ctx, {
        workflowId: args.context.workflowId,
        generationNumber: args.context.generationNumber,
        runResult: {
          kind: "failed",
          error:
            "Invalid handlerOnComplete context: " +
            JSON.stringify(args.context),
        },
      }).catch((error) => {
        console.error("Error calling completeHandler", error);
      });
      return;
    }
    const { workflowId, generationNumber } = args.context;
    await completeHandler(ctx, {
      workflowId,
      generationNumber,
      runResult: args.result,
    });
  },
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
