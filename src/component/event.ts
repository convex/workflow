import { deleteWebhook } from "./model.js";
// Get event status

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import { vResultValidator } from "@convex-dev/workpool";
import type { Doc, Id } from "./_generated/dataModel.js";
import { assert } from "convex-helpers";
import { enqueueWorkflow, getWorkpool, workpoolOptions } from "./pool.js";
import { checkForOversizedResult } from "./oversizedValues.js";
import { vWebhookSettings } from "./schema.js";
import { api, internal } from "./_generated/api.js";

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
      entry.step.runResult = checkForOversizedResult(event.state.result);
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
        step.step.runResult = checkForOversizedResult(args.result);
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
    timeoutMs: v.optional(v.number()),
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
    if (args.timeoutMs !== undefined) {
      await ctx.scheduler.runAfter(
        args.timeoutMs,
        internal.event.timeoutEvent,
        { eventId },
      );
    }
    return eventId;
  },
});

export const createWebhook = mutation({
  args: {
    name: v.string(),
    workflowId: v.id("workflows"),
    settings: v.optional(vWebhookSettings),
    timeoutMs: v.optional(v.number()),
  },
  returns: v.object({
    eventId: v.id("events"),
    uuid: v.string(),
    url: v.string(),
  }),
  handler: async (ctx, args) => {
    const siteUrl = process.env.CONVEX_SITE_URL;
    if (!siteUrl) {
      throw new Error(
        "CONVEX_SITE_URL is not set on the workflow component. Is this a test?",
      );
    }
    const eventId = await ctx.db.insert("events", {
      workflowId: args.workflowId,
      name: args.name,
      state: { kind: "created" },
    });
    const uuid = crypto.randomUUID();
    await ctx.db.insert("webhookCallbacks", {
      uuid,
      eventId,
      workflowId: args.workflowId,
      settings: args.settings ?? {},
    });
    if (args.timeoutMs !== undefined) {
      await ctx.scheduler.runAfter(
        args.timeoutMs,
        internal.event.timeoutEvent,
        { eventId },
      );
    }
    // Preserve the component mount path with or without a trailing slash.
    const url = new URL("webhook", `${siteUrl.replace(/\/+$/, "")}/`);
    url.searchParams.set("uuid", uuid);
    return { eventId, uuid, url: url.toString() };
  },
});

export const getWebhookByUuid = internalQuery({
  args: { uuid: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("webhookCallbacks"),
      _creationTime: v.number(),
      uuid: v.string(),
      eventId: v.id("events"),
      workflowId: v.id("workflows"),
      settings: vWebhookSettings,
      bodyStorageId: v.optional(v.id("_storage")),
      headersStorageId: v.optional(v.id("_storage")),
      eventState: v.union(
        v.literal("created"),
        v.literal("waiting"),
        v.literal("sent"),
        v.literal("consumed"),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const webhook = await ctx.db
      .query("webhookCallbacks")
      .withIndex("by_uuid", (q) => q.eq("uuid", args.uuid))
      .unique();
    if (!webhook) return null;
    const event = await ctx.db.get("events", webhook.eventId);
    if (!event) return null;
    return { ...webhook, eventState: event.state.kind };
  },
});

export const timeoutEvent = internalMutation({
  args: { eventId: v.id("events") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get("events", args.eventId);
    if (!event) return null;
    if (event.state.kind === "created" || event.state.kind === "waiting") {
      await ctx.runMutation(api.event.send, {
        eventId: args.eventId,
        result: { kind: "failed", error: "Timeout" },
      });
    }
    return null;
  },
});

// Recheck and send in one transaction so concurrent callbacks and timeouts
// cannot both complete the same event.
export const completeWebhook = internalMutation({
  args: {
    eventId: v.id("events"),
    value: v.any(),
    bodyStorageId: v.optional(v.id("_storage")),
    headersStorageId: v.optional(v.id("_storage")),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const event = await ctx.db.get("events", args.eventId);
    const webhook = await ctx.db
      .query("webhookCallbacks")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    const workflow =
      webhook && (await ctx.db.get("workflows", webhook.workflowId));
    if (
      !event ||
      !webhook ||
      !workflow ||
      event.state.kind === "sent" ||
      event.state.kind === "consumed"
    ) {
      // Files created by a losing delivery must not become orphans.
      for (const id of [args.bodyStorageId, args.headersStorageId]) {
        if (id) await ctx.storage.delete(id);
      }
      return false;
    }
    await ctx.runMutation(api.event.send, {
      eventId: args.eventId,
      result: { kind: "success", returnValue: args.value },
    });
    await ctx.db.patch("webhookCallbacks", webhook._id, {
      bodyStorageId: args.bodyStorageId,
      headersStorageId: args.headersStorageId,
    });
    return true;
  },
});

/** Resolve a spilled payload in component storage. Apps must authorize access
 * to the workflow before exposing this URL to an end user. The file is removed
 * when the workflow/event is cleaned up.
 */
export const getWebhookPayloadUrl = query({
  args: {
    eventId: v.id("events"),
    field: v.union(v.literal("body"), v.literal("headers")),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const webhook = await ctx.db
      .query("webhookCallbacks")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    const id =
      args.field === "body"
        ? webhook?.bodyStorageId
        : webhook?.headersStorageId;
    return id ? await ctx.storage.getUrl(id) : null;
  },
});

export const cleanupWebhooks = internalMutation({
  args: { workflowId: v.id("workflows") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("webhookCallbacks")
      .withIndex("by_workflowId", (q) => q.eq("workflowId", args.workflowId))
      .take(64);
    for (const webhook of batch) {
      await deleteWebhook(ctx, webhook);
      await ctx.db.delete("events", webhook.eventId);
    }
    if (batch.length === 64) {
      await ctx.scheduler.runAfter(0, internal.event.cleanupWebhooks, args);
    }
    return null;
  },
});
