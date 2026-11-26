import { vResultValidator, type RunResult } from "@convex-dev/workpool";
import { finishStep } from "./finish.js";
import { assert } from "convex-helpers";
import {
  paginationOptsValidator,
  type FunctionHandle,
  type PaginationResult,
} from "convex/server";
import { type Infer, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
} from "./_generated/server.js";
import { type Logger, logLevel } from "./logging.js";
import { getWorkflow } from "./model.js";
import { getWorkpool } from "./pool.js";
import {
  journalDocument,
  vOnComplete,
  workflowDocument,
  type JournalEntry,
} from "./schema.js";
import { getDefaultLogger } from "./utils.js";
import {
  type WorkflowId,
  type OnCompleteArgs,
  type WorkflowStep,
  type EventId,
  vPaginationResult,
  vWorkflowStep,
  type SchedulerOptions,
  type PublicWorkflow,
  vPublicWorkflow,
} from "../types.js";
import { api, internal } from "./_generated/api.js";
import { formatErrorWithStack } from "../shared.js";
import type { Doc, Id } from "./_generated/dataModel.js";

const createArgs = v.object({
  workflowName: v.string(),
  workflowHandle: v.string(),
  workflowArgs: v.any(),
  maxParallelism: v.optional(v.number()),
  onComplete: v.optional(vOnComplete),
  startAsync: v.optional(v.boolean()),
  createOnly: v.optional(v.boolean()),
  // TODO: ttl
});
export const create = mutation({
  args: createArgs,
  returns: v.id("workflows"),
  handler: createHandler,
});

export async function createHandler(
  ctx: MutationCtx,
  args: Infer<typeof createArgs>,
  schedulerOptions?: SchedulerOptions,
) {
  const console = await getDefaultLogger(ctx);
  await updateMaxParallelism(ctx, console, args.maxParallelism);
  const workflowId = await ctx.db.insert("workflows", {
    name: args.workflowName,
    workflowHandle: args.workflowHandle,
    args: args.workflowArgs,
    generationNumber: 0,
    onComplete: args.onComplete,
  });
  console.debug(
    `Created workflow ${workflowId}:`,
    args.workflowArgs,
    args.workflowHandle,
  );
  if (args.startAsync) {
    assert(
      !args.createOnly,
      "Cannot startAsync and createOnly at the same time",
    );
    const workpool = await getWorkpool(ctx, args);
    await workpool.enqueueMutation(
      ctx,
      args.workflowHandle as FunctionHandle<"mutation">,
      { workflowId, generationNumber: 0 },
      {
        name: args.workflowName,
        onComplete: internal.pool.handlerOnComplete,
        onCompleteExcludeKinds: ["success"],
        context: { workflowId, generationNumber: 0 },
        ...schedulerOptions,
      },
    );
  } else if (!args.createOnly) {
    // If we can't start it, may as well not create it, eh? Fail fast...
    await ctx.runMutation(args.workflowHandle as FunctionHandle<"mutation">, {
      workflowId,
      generationNumber: 0,
    });
  }
  return workflowId;
}

export const getStatus = query({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.object({
    workflow: workflowDocument,
    inProgress: v.array(journalDocument),
    logLevel: logLevel,
  }),
  handler: async (ctx, args) => {
    const workflow = await ctx.db.get("workflows", args.workflowId);
    assert(workflow, `Workflow not found: ${args.workflowId}`);
    const console = await getDefaultLogger(ctx);

    const inProgress = await ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", args.workflowId),
      )
      .collect();
    console.debug(`${args.workflowId} blocked by`, inProgress);
    return { workflow, inProgress, logLevel: console.logLevel };
  },
});

function publicWorkflowId(workflowId: Id<"workflows">): WorkflowId {
  return workflowId as any;
}

function publicWorkflow(workflow: Doc<"workflows">): PublicWorkflow {
  return {
    workflowId: publicWorkflowId(workflow._id),
    name: workflow.name,
    args: workflow.args,
    context: workflow.onComplete?.context,
    runResult: workflow.runResult,
  } satisfies PublicWorkflow;
}

function publicStep(step: JournalEntry): WorkflowStep {
  const commonFields = {
    workflowId: publicWorkflowId(step.workflowId),
    name: step.step.name,
    stepId: step._id,
    stepNumber: step.stepNumber,

    args: step.step.args,
    runResult: step.step.runResult,

    startedAt: step.step.startedAt,
    completedAt: step.step.completedAt,
  };
  switch (step.step.kind) {
    case "event":
      return {
        ...commonFields,
        kind: "event",
        eventId: step.step.eventId as unknown as EventId,
      };
    case "workflow":
      return {
        ...commonFields,
        kind: "workflow",
        nestedWorkflowId: publicWorkflowId(step.step.workflowId!),
      };
    case "function":
      return {
        ...commonFields,
        kind: "function",
        workId: step.step.workId,
      };
    case "sleep":
      return {
        ...commonFields,
        kind: "sleep",
        workId: step.step.workId!,
      };
    default:
      throw new Error(`Unknown step kind: ${(step.step as any).kind}`);
  }
}

export const list = query({
  args: {
    order: v.union(v.literal("asc"), v.literal("desc")),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vPublicWorkflow),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("workflows")
      .order(args.order)
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicWorkflow),
    } as PaginationResult<Infer<typeof vPublicWorkflow>>;
  },
});

export const listByName = query({
  args: {
    name: v.string(),
    order: v.union(v.literal("asc"), v.literal("desc")),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vPublicWorkflow),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("workflows")
      .withIndex("name", (q) => q.eq("name", args.name))
      .order(args.order)
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicWorkflow),
    } as PaginationResult<Infer<typeof vPublicWorkflow>>;
  },
});

export const listSteps = query({
  args: {
    workflowId: v.id("workflows"),
    order: v.union(v.literal("asc"), v.literal("desc")),
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vWorkflowStep),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", args.workflowId))
      .order(args.order)
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map(publicStep),
    } as PaginationResult<Infer<typeof vWorkflowStep>>;
  },
});

const restartArgs = v.object({
  workflowId: v.id("workflows"),
  from: v.optional(v.union(v.number(), v.string())),
  startAsync: v.optional(v.boolean()),
});

export const restart = mutation({
  args: restartArgs,
  returns: v.null(),
  handler: restartHandler,
});

export async function restartHandler(
  ctx: MutationCtx,
  args: Infer<typeof restartArgs>,
) {
  const workflow = await ctx.db.get("workflows", args.workflowId);
  assert(workflow, `Workflow not found: ${args.workflowId}`);
  const console = await getDefaultLogger(ctx);

  if (!workflow.runResult) {
    throw new Error(`Workflow is still running: ${args.workflowId}`);
  }

  // Delete steps from the specified point
  if (args.from !== undefined) {
    if (typeof args.from === "number") {
      if (args.from < 0) {
        throw new Error(`Step number cannot be negative: ${args.from}`);
      }
      const stepsToDelete = await ctx.db
        .query("steps")
        .withIndex("workflow", (q) =>
          q
            .eq("workflowId", args.workflowId)
            .gte("stepNumber", args.from as number),
        )
        .collect();
      if (stepsToDelete.length === 0) {
        console.warn(
          `Step number ${args.from} not found in workflow ${args.workflowId}`,
        );
      }
      await deleteSteps(ctx, stepsToDelete);
    } else {
      // Walk backwards to find step by name, collecting steps to delete
      const stepsDesc = ctx.db
        .query("steps")
        .withIndex("workflow", (q) => q.eq("workflowId", args.workflowId))
        .order("desc");
      let found = false;
      const toDelete: Doc<"steps">[] = [];
      for await (const step of stepsDesc) {
        toDelete.push(step);
        if (step.step.name === args.from) {
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(
          `Step "${args.from}" not found in workflow ${args.workflowId}`,
        );
      }
      await deleteSteps(ctx, toDelete);
    }
  }

  // Increment generation number and clear result
  const generationNumber = workflow.generationNumber + 1;
  await ctx.db.patch("workflows", args.workflowId, {
    generationNumber,
    runResult: undefined,
  });

  console.event("retry", {
    workflowId: args.workflowId,
    name: workflow.name,
    from: args.from,
  });

  if (args.startAsync) {
    const workpool = await getWorkpool(ctx, {});
    await workpool.enqueueMutation(
      ctx,
      workflow.workflowHandle as FunctionHandle<"mutation">,
      { workflowId: args.workflowId, generationNumber },
      {
        name: workflow.name,
        onComplete: internal.pool.handlerOnComplete,
        onCompleteExcludeKinds: ["success"],
        context: { workflowId: args.workflowId, generationNumber },
      },
    );
  } else {
    await ctx.runMutation(
      workflow.workflowHandle as FunctionHandle<"mutation">,
      {
        workflowId: args.workflowId,
        generationNumber,
      },
    );
  }
}

export const cancel = mutation({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    const workflow = await ctx.db.get("workflows", workflowId);
    assert(workflow, `Workflow not found: ${workflowId}`);
    await completeHandler(ctx, {
      workflowId,
      generationNumber: workflow.generationNumber,
      runResult: { kind: "canceled" },
    });
  },
});

const completeArgs = v.object({
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
  runResult: vResultValidator,
});

export const complete = mutation({
  args: completeArgs,
  returns: v.null(),
  handler: completeHandler,
});

// When the handler finishes, or `cancel` or a failed handler run ends the
// workflow. Checks the generation, so a handler run from before a restart
// can't end the restarted workflow.
export async function completeHandler(
  ctx: MutationCtx,
  args: Infer<typeof completeArgs>,
) {
  const workflow = await getWorkflow(
    ctx,
    args.workflowId,
    args.generationNumber,
  );
  if (workflow.runResult) {
    throw new Error(`Workflow not running: ${workflow._id}`);
  }
  await endWorkflow(ctx, workflow, args.runResult);
}

/**
 * The one place a workflow ends, whatever the result. Every step still in
 * progress is closed with a canceled result (finishStep, which also closes
 * its event), and its work is stopped: queued functions and sleeps are
 * canceled in the workpool, and child workflows are canceled. This happens
 * on success and failure too, not only on cancel: a branch still running
 * beside a failed `Promise.all`, or a step the handler never awaited, is
 * stopped when its workflow ends. Then `onComplete` runs.
 */
export async function endWorkflow(
  ctx: MutationCtx,
  workflow: Doc<"workflows">,
  runResult: RunResult,
) {
  const console = await getDefaultLogger(ctx);
  workflow.runResult = runResult;
  console.event("completed", {
    workflowId: workflow._id,
    name: workflow.name,
    status: runResult.kind,
    overallDurationMs: Date.now() - workflow._creationTime,
  });
  // Written first, so the finishStep calls below and any child's onComplete
  // see a finished workflow and don't enqueue a replay.
  await ctx.db.replace("workflows", workflow._id, workflow);
  // TODO: can we cancel these asynchronously if there's more than one?
  const inProgress = await ctx.db
    .query("steps")
    .withIndex("inProgress", (q) =>
      q.eq("step.inProgress", true).eq("workflowId", workflow._id),
    )
    .collect();
  if (inProgress.length > 0) {
    const workpool = await getWorkpool(ctx, {});
    for (const entry of inProgress) {
      const { step } = entry;
      // Closed before its work is stopped, so the canceled job's or child's
      // own completion finds the step closed and changes nothing.
      await finishStep(ctx, entry, { kind: "canceled" }, { replay: false });
      if (!step.kind || step.kind === "function" || step.kind === "sleep") {
        if (step.workId) {
          await workpool.cancel(ctx, step.workId);
        }
      } else if (step.kind === "workflow" && step.workflowId) {
        const child = await ctx.db.get("workflows", step.workflowId);
        if (child && child.runResult === undefined) {
          await endWorkflow(ctx, child, { kind: "canceled" });
        }
      }
    }
  }
  if (workflow.onComplete) {
    try {
      await ctx.runMutation(
        workflow.onComplete.fnHandle as FunctionHandle<
          "mutation",
          OnCompleteArgs
        >,
        {
          workflowId: workflow._id as unknown as WorkflowId,
          result: workflow.runResult,
          context: workflow.onComplete.context,
        },
      );
    } catch (error) {
      const message = formatErrorWithStack(error);
      console.error("Error calling onComplete", message);
      await ctx.db.insert("onCompleteFailures", {
        workflowId: workflow._id,
        generationNumber: workflow.generationNumber,
        runResult,
        error: message,
      });
    }
  }
  // TODO: delete everything unless ttl is set
  console.debug(`Completed workflow ${workflow._id}:`, workflow);
}

export const cleanup = mutation({
  args: {
    workflowId: v.string(),
    force: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const workflowId = ctx.db.normalizeId("workflows", args.workflowId);
    if (!workflowId) {
      throw new Error(`Invalid workflow ID: ${args.workflowId}`);
    }
    const workflow = await ctx.db.get("workflows", workflowId);
    if (!workflow) {
      return false;
    }
    const logger = await getDefaultLogger(ctx);
    // TODO: allow cleaning up a workflow from inside it / in the onComplete hook
    if (!workflow.runResult) {
      if (!args.force) {
        logger.debug(
          `Can't clean up workflow ${workflowId} since it hasn't completed.`,
        );
        return false;
      }
      logger.debug(`Workflow ${workflowId} is not completed, forcing anyways`);
    }
    logger.debug(`Cleaning up workflow ${workflowId}`, workflow);
    await ctx.db.delete("workflows", workflowId);
    await cleanupStepsFrom(ctx, workflowId, 0);
    return true;
  },
});

export const cleanupContinue = internalMutation({
  args: {
    workflowId: v.id("workflows"),
    fromStepNumber: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await cleanupStepsFrom(ctx, args.workflowId, args.fromStepNumber);
    return null;
  },
});

const CLEANUP_BATCH_SIZE = 256;

export const cleanupEventsContinue = internalMutation({
  args: { workflowId: v.id("workflows") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await cleanupEvents(ctx, args.workflowId);
    return null;
  },
});

// Deletes every event of the workflow, including ones sent but never waited
// for, which no step refers to. Runs after the last batch of steps is gone,
// so a later step batch can't find its event already deleted. Events can be
// large (a sent event holds its payload), so it checks the budget after each
// one rather than reading a fixed batch.
async function cleanupEvents(ctx: MutationCtx, workflowId: Id<"workflows">) {
  for await (const event of ctx.db
    .query("events")
    .withIndex("workflowId_state", (q) => q.eq("workflowId", workflowId))) {
    await ctx.db.delete("events", event._id);
    if (await transactionBudgetMostlyConsumed(ctx)) {
      await ctx.scheduler.runAfter(0, internal.workflow.cleanupEventsContinue, {
        workflowId,
      });
      return;
    }
  }
}

async function transactionBudgetMostlyConsumed(
  ctx: MutationCtx,
): Promise<boolean> {
  const m = await ctx.meta.getTransactionMetrics();
  return (
    m.bytesRead.used > m.bytesRead.remaining ||
    m.bytesWritten.used > m.bytesWritten.remaining ||
    m.databaseQueries.used > m.databaseQueries.remaining ||
    m.documentsRead.used > m.documentsRead.remaining ||
    m.documentsWritten.used > m.documentsWritten.remaining ||
    m.functionsScheduled.used > m.functionsScheduled.remaining ||
    m.scheduledFunctionArgsBytes.used > m.scheduledFunctionArgsBytes.remaining
  );
}

async function updateMaxParallelism(
  ctx: MutationCtx,
  console: Logger,
  maxParallelism: number | undefined,
) {
  const config = await ctx.db.query("config").first();
  if (config) {
    if (maxParallelism && maxParallelism !== config.maxParallelism) {
      console.warn("Updating max parallelism to", maxParallelism);
      await ctx.db.patch("config", config._id, { maxParallelism });
    }
  } else {
    await ctx.db.insert("config", { maxParallelism });
  }
}

async function cleanupStepsFrom(
  ctx: MutationCtx,
  workflowId: Id<"workflows">,
  fromStepNumber: number,
) {
  while (true) {
    const batch = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) =>
        q.eq("workflowId", workflowId).gte("stepNumber", fromStepNumber),
      )
      .take(CLEANUP_BATCH_SIZE);
    if (batch.length === 0) {
      await cleanupEvents(ctx, workflowId);
      return;
    }
    await deleteSteps(ctx, batch);
    fromStepNumber = batch[batch.length - 1].stepNumber + 1;
    if (batch.length < CLEANUP_BATCH_SIZE) {
      await cleanupEvents(ctx, workflowId);
      return;
    }
    if (await transactionBudgetMostlyConsumed(ctx)) {
      await ctx.scheduler.runAfter(0, internal.workflow.cleanupContinue, {
        workflowId,
        fromStepNumber,
      });
      return;
    }
  }
}

async function deleteSteps(ctx: MutationCtx, batch: Doc<"steps">[]) {
  const nestedWorkflowIds: Id<"workflows">[] = [];
  await Promise.all(
    batch.map(async (entry) => {
      await ctx.db.delete("steps", entry._id);
      if (entry.step.kind === "event" && entry.step.eventId) {
        // Already gone if another workflow's cleanup deleted it (a step can
        // wait on another workflow's event by ID).
        if (await ctx.db.get("events", entry.step.eventId)) {
          await ctx.db.delete("events", entry.step.eventId);
        }
      } else if (entry.step.kind === "workflow" && entry.step.workflowId) {
        nestedWorkflowIds.push(entry.step.workflowId);
      }
    }),
  );
  if (nestedWorkflowIds.length > 0) {
    const workpool = await getWorkpool(ctx, {});
    await workpool.enqueueMutationBatch(
      ctx,
      api.workflow.cleanup,
      nestedWorkflowIds.map((id) => ({ workflowId: id, force: true })),
    );
  }
}

export const sleep = internalQuery({
  args: {},
  returns: v.null(),
  handler: async () => null,
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
