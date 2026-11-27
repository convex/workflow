// Get event status

import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server.js";
import {
  vResultValidator,
  type RunResult,
  type WorkpoolOptions,
} from "@convex-dev/workpool";
import { internal } from "./_generated/api.js";
import { getDefaultLogger } from "./utils.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { assert } from "convex-helpers";
import { enqueueWorkflow, getWorkpool, workpoolOptions } from "./pool.js";
import { checkForOversizedResult } from "./oversizedValues.js";

export async function awaitEvent(
  ctx: MutationCtx,
  entry: Doc<"steps">,
  args: {
    eventId?: Id<"events">;
    name: string;
    timeout?: number;
    workpoolOptions?: WorkpoolOptions;
  },
) {
  const timed = args.timeout !== undefined;
  // A timed wait by name consumes an event of that name that was sent before
  // it started. Otherwise it gets its own event record rather than reusing a
  // "created" one, so nothing else waits on it and nothing outlives it. A late
  // send for an earlier timed wait is never stored (see `send`), so a stored
  // "sent" event is always one nobody has received yet.
  const event =
    timed && !args.eventId
      ? ((await findEvent(ctx, entry.workflowId, args, ["sent"])) ??
        (await insertEvent(ctx, entry.workflowId, args.name)))
      : await getOrCreateEvent(ctx, entry.workflowId, args, [
          "sent",
          "created",
        ]);
  switch (event.state.kind) {
    case "consumed": {
      throw new Error(
        `Event already consumed: ${event._id} (${entry.step.name}) in workflow ${entry.workflowId} step ${entry.stepNumber} (${entry._id})`,
      );
    }
    case "waiting": {
      throw new Error(
        `Event already waiting: ${event._id} (${entry.step.name}) in workflow ${entry.workflowId} step ${entry.stepNumber} (${entry._id})`,
      );
    }
    case "timedOut": {
      throw new Error(
        `Event already timed out: ${event._id} (${entry.step.name}) in workflow ${entry.workflowId} step ${entry.stepNumber} (${entry._id})`,
      );
    }
  }

  switch (event.state.kind) {
    case "sent": {
      await ctx.db.patch("events", event._id, {
        timeout: args.timeout,
        state: {
          kind: "consumed",
          sentAt: event.state.sentAt,
          waitingAt: Date.now(),
          consumedAt: Date.now(),
          stepId: entry._id,
        },
      });
      entry.step.runResult = checkForOversizedResult(
        timed ? timedEventResult(event.state.result) : event.state.result,
      );
      entry.step.inProgress = false;
      entry.step.completedAt = Date.now();
      break;
    }
    case "created": {
      await ctx.db.patch("events", event._id, {
        timeout: args.timeout,
        state: {
          kind: "waiting",
          waitingAt: Date.now(),
          stepId: entry._id,
        },
      });
      if (args.timeout !== undefined) {
        await ctx.scheduler.runAfter(args.timeout, internal.event.timeoutWait, {
          eventId: event._id,
          stepId: entry._id,
          workpoolOptions: args.workpoolOptions,
        });
      }
      break;
    }
  }
  assert(entry.step.kind === "event", "Step is not an event");
  entry.step.eventId = event._id;
  // if there's a name, see if there's one to consume.
  // if it's there, mark it consumed and swap in the result.
  return entry;
}

/**
 * A timed wait resolves to `{ kind: "event", value }` or `{ kind: "timeout" }`.
 * Errors and cancellations sent with the event pass through unchanged, so
 * they throw in the workflow just like an untimed wait.
 */
function timedEventResult(result: RunResult): RunResult {
  if (result.kind !== "success") return result;
  return {
    kind: "success",
    returnValue: { kind: "event", value: result.returnValue },
  };
}

async function insertEvent(
  ctx: MutationCtx,
  workflowId: Id<"workflows">,
  name: string,
): Promise<Doc<"events">> {
  const eventId = await ctx.db.insert("events", {
    workflowId,
    name,
    state: { kind: "created" },
  });
  return (await ctx.db.get("events", eventId))!;
}

async function getOrCreateEvent(
  ctx: MutationCtx,
  workflowId: Id<"workflows"> | undefined,
  args: { eventId?: Id<"events">; name?: string },
  statuses: Doc<"events">["state"]["kind"][],
): Promise<Doc<"events">> {
  const event = await findEvent(ctx, workflowId, args, statuses);
  if (event) return event;
  return insertEvent(ctx, workflowId!, args.name!);
}

async function findEvent(
  ctx: MutationCtx,
  workflowId: Id<"workflows"> | undefined,
  args: { eventId?: Id<"events">; name?: string },
  statuses: Doc<"events">["state"]["kind"][],
): Promise<Doc<"events"> | null> {
  if (args.eventId) {
    const event = await ctx.db.get("events", args.eventId);
    if (!event) {
      throw new Error(
        `Event not found: ${args.eventId} (${args.name}) in workflow ${workflowId}`,
      );
    }
    return event;
  }
  assert(args.name, "Name is required if eventId is not specified");
  assert(workflowId, "workflowId is required if eventId is not specified");
  for (const status of statuses) {
    const event = await ctx.db
      .query("events")
      .withIndex("workflowId_state", (q) =>
        q.eq("workflowId", workflowId).eq("state.kind", status),
      )
      .filter((q) => q.eq(q.field("name"), args.name))
      .first();
    if (event) return event;
  }
  return null;
}

/**
 * True if this event belonged to a timed wait that has already ended. Sends
 * to such an event are dropped.
 */
function isEndedTimedWait(event: Doc<"events">): boolean {
  return (
    event.timeout !== undefined &&
    (event.state.kind === "consumed" || event.state.kind === "timedOut")
  );
}

export const send = mutation({
  args: {
    workflowId: v.optional(v.id("workflows")),
    eventId: v.optional(v.id("events")),
    name: v.optional(v.string()),
    result: vResultValidator,
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.id("events"),
  handler: async (ctx, args) => {
    let event = await findEvent(
      ctx,
      args.workflowId,
      { eventId: args.eventId, name: args.name },
      ["waiting", "created"],
    );
    if (!event) {
      // Sending by name with nothing waiting. If the most recent event with
      // this name was a timed wait that already ended, this send is late:
      // drop it rather than store it for some later wait.
      const latest = await ctx.db
        .query("events")
        .withIndex("workflowId_name", (q) =>
          q.eq("workflowId", args.workflowId!).eq("name", args.name!),
        )
        .order("desc")
        .first();
      if (latest && isEndedTimedWait(latest)) {
        return latest._id;
      }
      event = await insertEvent(ctx, args.workflowId!, args.name!);
    }
    const { workflowId } = event;
    const name = args.name ?? event.name;
    if (isEndedTimedWait(event)) {
      // Late or duplicate send to a timed wait that already ended.
      return event._id;
    }
    switch (event.state.kind) {
      case "sent": {
        throw new Error(
          `Event already sent: ${event._id} (${name}) in workflow ${workflowId}`,
        );
      }
      case "consumed": {
        throw new Error(
          `Event already consumed: ${event._id} (${name}) in workflow ${workflowId}`,
        );
      }
      case "timedOut": {
        // Only timed waits time out, so isEndedTimedWait handled this above.
        return event._id;
      }
      case "created": {
        await ctx.db.patch("events", event._id, {
          state: { kind: "sent", result: args.result, sentAt: Date.now() },
        });
        break;
      }
      case "waiting": {
        const step = await ctx.db.get("steps", event.state.stepId);
        assert(
          step,
          `Entry ${event.state.stepId} not found when sending event ${event._id} (${name}) in workflow ${workflowId}`,
        );
        assert(step.step.kind === "event", "Step is not an event");
        const timed = event.timeout !== undefined;
        if (timed) {
          // The wait ends with its workflow. A send after the workflow
          // finished or was canceled is dropped.
          const workflow = await ctx.db.get("workflows", workflowId);
          if (!workflow || workflow.runResult !== undefined) {
            return event._id;
          }
        }
        step.step.eventId = event._id;
        step.step.runResult = checkForOversizedResult(
          timed ? timedEventResult(args.result) : args.result,
        );
        step.step.inProgress = false;
        step.step.completedAt = Date.now();
        await ctx.db.replace("steps", step._id, step);
        await ctx.db.patch("events", event._id, {
          state: {
            kind: "consumed",
            stepId: step._id,
            waitingAt: event.state.waitingAt,
            sentAt: Date.now(),
            consumedAt: Date.now(),
          },
        });
        await resumeIfNoWaitingEvents(ctx, workflowId, args.workpoolOptions);
        break;
      }
    }
    return event._id;
  },
});

async function resumeIfNoWaitingEvents(
  ctx: MutationCtx,
  workflowId: Id<"workflows">,
  options: WorkpoolOptions | undefined,
) {
  const anyMoreEvents = await ctx.db
    .query("events")
    .withIndex("workflowId_state", (q) =>
      q.eq("workflowId", workflowId).eq("state.kind", "waiting"),
    )
    .order("desc")
    .first();
  if (!anyMoreEvents) {
    const workflow = await ctx.db.get("workflows", workflowId);
    assert(workflow, `Workflow ${workflowId} not found`);
    const workpool = await getWorkpool(ctx, options);
    await enqueueWorkflow(ctx, workflow, workpool);
  }
}

/**
 * Scheduled when a timed wait starts. Ends the wait with `{ kind: "timeout" }`
 * unless it already ended. Whichever of this and `send` commits first changes
 * the event out of "waiting"; the other then sees that and does nothing.
 */
export const timeoutWait = internalMutation({
  args: {
    eventId: v.id("events"),
    stepId: v.id("steps"),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("events", args.eventId);
    if (
      !event ||
      event.state.kind !== "waiting" ||
      event.state.stepId !== args.stepId
    ) {
      return null;
    }
    await ctx.db.patch("events", event._id, {
      state: {
        kind: "timedOut",
        waitingAt: event.state.waitingAt,
        timedOutAt: Date.now(),
        stepId: args.stepId,
      },
    });
    const workflow = await ctx.db.get("workflows", event.workflowId);
    if (!workflow) {
      return null;
    }
    const step = await ctx.db.get("steps", args.stepId);
    if (!step || !step.step.inProgress) {
      return null;
    }
    const console = await getDefaultLogger(ctx);
    step.step.runResult = {
      kind: "success",
      returnValue: { kind: "timeout" },
    };
    step.step.inProgress = false;
    step.step.completedAt = Date.now();
    await ctx.db.replace("steps", step._id, step);
    console.event("eventTimedOut", {
      workflowId: workflow._id,
      workflowName: workflow.name,
      eventName: event.name,
      stepNumber: step.stepNumber,
      durationMs: step.step.completedAt - step.step.startedAt,
    });
    // The step ends even if the workflow already finished: a replay that
    // fails the workflow can still start this wait (a Promise.all branch
    // beside the failed one), and nothing else would mark it done. Only a
    // running workflow needs to replay.
    if (workflow.runResult === undefined) {
      await resumeIfNoWaitingEvents(ctx, workflow._id, args.workpoolOptions);
    }
    return null;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    workflowId: v.id("workflows"),
  },
  returns: v.id("events"),
  handler: async (ctx, args) => {
    const eventId = await ctx.db.insert("events", {
      workflowId: args.workflowId,
      name: args.name,
      state: {
        kind: "created",
      },
    });
    return eventId;
  },
});
