import { getConvexSize, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  journalDocument,
  type JournalEntry,
  step,
  workflowDocument,
} from "./schema.js";
import { getWorkflow } from "./model.js";
import { logLevel } from "./logging.js";
import { vRetryBehavior, type WorkId } from "@convex-dev/workpool";
import {
  getWorkpool,
  type OnCompleteContext,
  workpoolOptions,
} from "./pool.js";
import { internal } from "./_generated/api.js";
import { createFunctionHandle, type FunctionHandle } from "convex/server";
import { getDefaultLogger } from "./utils.js";
import { assert } from "convex-helpers";
import { MAX_JOURNAL_SIZE } from "../shared.js";
import { awaitEvent } from "./event.js";
import type { Id } from "./_generated/dataModel.js";

export const load = query({
  args: {
    workflowId: v.id("workflows"),
    shortCircuit: v.optional(v.boolean()),
  },
  returns: v.object({
    workflow: workflowDocument,
    journalEntries: v.array(journalDocument),
    ok: v.boolean(),
    logLevel,
    blocked: v.optional(v.boolean()),
  }),
  handler: async (ctx, { workflowId, shortCircuit }) => {
    const workflow = await ctx.db.get("workflows", workflowId);
    assert(workflow, `Workflow not found: ${workflowId}`);
    const { logLevel } = await getDefaultLogger(ctx);
    const journalEntries: JournalEntry[] = [];
    let journalSize = 0;
    if (shortCircuit) {
      const inProgress = await ctx.db
        .query("steps")
        .withIndex("inProgress", (q) =>
          q.eq("step.inProgress", true).eq("workflowId", workflowId),
        )
        .first();
      if (inProgress) {
        return {
          journalEntries: [inProgress],
          blocked: true,
          workflow,
          logLevel,
          ok: true,
        };
      }
    }
    for await (const entry of ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))) {
      journalEntries.push(entry);
      journalSize += getConvexSize(entry);
      if (journalSize > MAX_JOURNAL_SIZE) {
        return { journalEntries, workflow, logLevel, ok: false };
      }
    }
    return { journalEntries, workflow, logLevel, ok: true };
  },
});

export const startSteps = mutation({
  args: {
    workflowId: v.id("workflows"),
    generationNumber: v.number(),
    steps: v.array(
      v.object({
        step,
        retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
        schedulerOptions: v.optional(
          v.union(
            v.object({ runAt: v.optional(v.number()) }),
            v.object({ runAfter: v.optional(v.number()) }),
          ),
        ),
      }),
    ),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.array(journalDocument),
  handler: async (ctx, args): Promise<JournalEntry[]> => {
    const { generationNumber } = args;
    const workflow = await getWorkflow(ctx, args.workflowId, generationNumber);
    const console = await getDefaultLogger(ctx);

    if (workflow.runResult !== undefined) {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    const stepNumberBase = maxEntry ? maxEntry.stepNumber + 1 : 0;
    const workpool = await getWorkpool(ctx, args.workpoolOptions);
    const onComplete = internal.pool.onComplete;

    const entries = await Promise.all(
      args.steps.map(async (stepArgs, index) => {
        const { retry, schedulerOptions } = stepArgs;
        const stepNumber = stepNumberBase + index;
        const stepId = await ctx.db.insert("steps", {
          workflowId: workflow._id,
          stepNumber,
          step: stepArgs.step,
        });
        let entry = await ctx.db.get("steps", stepId);
        assert(entry, "Step not found");
        const step = entry.step;
        const { name } = step;
        console.event("started", {
          workflowId: workflow._id,
          workflowName: workflow.name,
          stepName: name,
          stepNumber,
        });
        if (step.kind === "event") {
          // Note: This modifies entry in place as well.
          entry = await awaitEvent(ctx, entry, {
            name,
            eventId: step.args.eventId,
          });
          if (step.runResult) {
            console.event("eventConsumed", {
              workflowId: entry.workflowId,
              workflowName: workflow.name,
              status: step.runResult.kind,
              eventName: step.name,
              stepNumber: stepNumber,
              durationMs: step.completedAt! - step.startedAt,
            });
          }
        } else if (step.kind === "workflow") {
          // Let the child definition create its workflow so it supplies its
          // own version, which may differ from the parent step's version.
          const workflowId = await ctx.runMutation(
            step.handle as FunctionHandle<"mutation">,
            {
              args: step.args,
              onComplete: await createFunctionHandle(
                internal.pool.nestedWorkflowOnComplete,
              ),
              context: {
                stepId,
                generationNumber,
                workpoolOptions: args.workpoolOptions,
              } satisfies OnCompleteContext,
              startAsync: true,
            },
          );
          step.workflowId = workflowId as Id<"workflows">;
        } else if (step.runResult) {
          // Already completed inline by the caller — nothing to enqueue.
          console.event("stepCompleted", {
            workflowId: entry.workflowId,
            workflowName: workflow.name,
            status: step.runResult.kind,
            stepName: step.name,
            stepNumber: stepNumber,
          });
        } else if (step.kind === "sleep") {
          const context: OnCompleteContext = {
            generationNumber,
            stepId,
            workpoolOptions: args.workpoolOptions,
          };
          step.workId = await workpool.enqueueQuery(
            ctx,
            internal.workflow.sleep,
            {},
            { context, onComplete, name, ...schedulerOptions },
          );
        } else {
          const context: OnCompleteContext = {
            generationNumber,
            stepId,
            workpoolOptions: args.workpoolOptions,
          };
          let workId: WorkId;
          switch (step.functionType) {
            case "query": {
              workId = await workpool.enqueueQuery(
                ctx,
                step.handle as FunctionHandle<"query">,
                step.args,
                { context, onComplete, name, ...schedulerOptions },
              );
              break;
            }
            case "mutation": {
              workId = await workpool.enqueueMutation(
                ctx,
                step.handle as FunctionHandle<"mutation">,
                step.args,
                { context, onComplete, name, ...schedulerOptions },
              );
              break;
            }
            case "action": {
              workId = await workpool.enqueueAction(
                ctx,
                step.handle as FunctionHandle<"action">,
                step.args,
                { context, onComplete, name, retry, ...schedulerOptions },
              );
              break;
            }
          }
          step.workId = workId;
        }
        await ctx.db.replace("steps", entry._id, entry);

        return entry;
      }),
    );
    return entries;
  },
});
