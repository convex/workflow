// Get event status

import { v } from "convex/values";
import { mutation, type MutationCtx } from "./_generated/server.js";
import { vResultValidator } from "@convex-dev/workpool";
import type { Doc, Id } from "./_generated/dataModel.js";
import { assert } from "convex-helpers";
import { enqueueWorkflow, getWorkpool, workpoolOptions } from "./pool.js";
import { checkForOversizedResult } from "./oversizedValues.js";

export async function awaitEvent(
  ctx: MutationCtx,
  entry: Doc<"steps">,
  args: { eventId?: Id<"events">; name: string },
) {
  const event = await getOrCreateEvent(ctx, entry.workflowId, args, [
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
  }

  switch (event.state.kind) {
    case "sent": {
      await ctx.db.patch("events", event._id, {
        state: {
          kind: "consumed",
          sentAt: event.state.sentAt,
          waitingAt: Date.now(),
          consumedAt: Date.now(),
          stepId: entry._id,
        },
      });
      entry.step.runResult = await checkForOversizedResult(
        ctx,
        event.state.result,
        { stepId: entry._id },
      );
      entry.step.inProgress = false;
      entry.step.completedAt = Date.now();
      break;
    }
    case "created": {
      await ctx.db.patch("events", event._id, {
        state: {
          kind: "waiting",
          waitingAt: Date.now(),
          stepId: entry._id,
        },
      });
      break;
    }
  }
  assert(entry.step.kind === "event", "Step is not an event");
  entry.step.eventId = event._id;
  // if there's a name, see if there's one to consume.
  // if it's there, mark it consumed and swap in the result.
  return entry;
}

async function getOrCreateEvent(
  ctx: MutationCtx,
  workflowId: Id<"workflows"> | undefined,
  args: { eventId?: Id<"events">; name?: string },
  statuses: Doc<"events">["state"]["kind"][],
): Promise<Doc<"events">> {
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
  const eventId = await ctx.db.insert("events", {
    workflowId,
    name: args.name,
    state: {
      kind: "created",
    },
  });
  return (await ctx.db.get("events", eventId))!;
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
    const event = await getOrCreateEvent(
      ctx,
      args.workflowId,
      {
        eventId: args.eventId,
        name: args.name,
      },
      ["waiting", "created"],
    );
    const { workflowId } = event;
    const name = args.name ?? event.name;
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
        step.step.eventId = event._id;
        step.step.runResult = await checkForOversizedResult(
          ctx,
          args.result,
          { stepId: step._id },
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
          const workpool = await getWorkpool(ctx, args.workpoolOptions);
          await enqueueWorkflow(ctx, workflow, workpool);
        }
        break;
      }
    }
    return event._id;
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
