// The one place an open step ends. Every path that finishes a step in
// progress calls `finishStep`: a queued function or sleep returning
// (pool.ts onCompleteHandler), a child workflow ending (same handler), an
// event arriving (event.ts `send`), a timed wait timing out (event.ts
// `timeoutWait`), and the workflow itself ending (workflow.ts `endWorkflow`,
// which closes every step still open).
//
// Steps that are complete when they are created (an inline query or
// mutation, or a wait that finds its event already sent) never pass through
// "in progress", so journal.startSteps writes them directly, after the same
// size check (`closeStep`).

import type { RunResult, WorkpoolOptions } from "@convex-dev/workpool";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { checkForOversizedResult } from "./oversizedValues.js";
import { enqueueWorkflow, getWorkpool } from "./pool.js";
import { getDefaultLogger } from "./utils.js";

type EventState = Doc<"events">["state"];

/** Marks `entry` done with `runResult`, in memory. */
export function closeStep(entry: Doc<"steps">, runResult: RunResult) {
  entry.step.inProgress = false;
  entry.step.completedAt = Date.now();
  entry.step.runResult = checkForOversizedResult(runResult);
}

/**
 * Ends `entry` with `runResult` if it is still in progress, and returns
 * whether it did. A step that already ended is left alone: a late result for
 * it (a canceled job, a send after a timeout, a child that finished after its
 * parent ended) changes nothing.
 *
 * For an event step, its event moves to `event` in the same write, or to
 * "canceled" if no state is given and it is still waiting, so no event is
 * left "waiting" on a step that has ended.
 *
 * With `replay`, the workflow's handler is enqueued if the workflow is still
 * running and this was its last step in progress. Steps that end while
 * others are still running don't replay; the last one to end does.
 */
export async function finishStep(
  ctx: MutationCtx,
  entry: Doc<"steps">,
  runResult: RunResult,
  opts: {
    event?: EventState;
    replay: boolean;
    workpoolOptions?: WorkpoolOptions;
  },
): Promise<boolean> {
  const console = await getDefaultLogger(ctx);
  if (!entry.step.inProgress) {
    console.debug(
      `Step ${entry._id} already ${entry.step.runResult?.kind}; ignoring ${runResult.kind}`,
    );
    return false;
  }
  closeStep(entry, runResult);
  await ctx.db.replace("steps", entry._id, entry);
  if (entry.step.kind === "event" && entry.step.eventId) {
    const event = await ctx.db.get("events", entry.step.eventId);
    if (event && opts.event) {
      await ctx.db.patch("events", event._id, { state: opts.event });
    } else if (event && event.state.kind === "waiting") {
      await ctx.db.patch("events", event._id, {
        state: {
          kind: "canceled",
          waitingAt: event.state.waitingAt,
          canceledAt: Date.now(),
          stepId: entry._id,
        },
      });
    }
  }
  const workflow = await ctx.db.get("workflows", entry.workflowId);
  console.event("stepCompleted", {
    workflowId: entry.workflowId,
    workflowName: workflow?.name,
    status: runResult.kind,
    stepName: entry.step.name,
    stepNumber: entry.stepNumber,
    durationMs: entry.step.completedAt! - entry.step.startedAt,
  });
  if (!opts.replay || !workflow || workflow.runResult !== undefined) {
    return true;
  }
  const stillRunning = await ctx.db
    .query("steps")
    .withIndex("inProgress", (q) =>
      q.eq("step.inProgress", true).eq("workflowId", workflow._id),
    )
    .first();
  if (!stillRunning) {
    const workpool = await getWorkpool(ctx, opts.workpoolOptions);
    await enqueueWorkflow(ctx, workflow, workpool);
  }
  return true;
}
