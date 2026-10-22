import { type Value, convexToJson, getConvexSize, jsonToConvex, v } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import type { RunResult } from "@convex-dev/workpool";
import { doc } from "convex-helpers/validators";
import { paginator } from "convex-helpers/server/pagination";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { vPaginationResult } from "../types.js";

export const MAX_RETURN_VALUE_SIZE = 800 << 10;
const PREVIEW_SIZE = 8 << 10;

function truncatedPreview(returnValue: unknown): string {
  const json = JSON.stringify(convexToJson(returnValue as Value));
  if (json.length <= PREVIEW_SIZE * 2) {
    return json;
  }
  return json.slice(0, PREVIEW_SIZE) + "..." + json.slice(-PREVIEW_SIZE);
}

export function checkReturnValueSize(
  returnValue: Value | undefined,
): string | null {
  const size = getConvexSize(returnValue);
  if (size > MAX_RETURN_VALUE_SIZE) {
    return `Step return value too large (${size} bytes). Maximum is ${MAX_RETURN_VALUE_SIZE} bytes. Retrieve it with ctx.runAction(components.workflow.oversizedValues.read, { stepId }). Preview: ${truncatedPreview(returnValue)}`;
  }
  return null;
}

export async function checkForOversizedResult(
  ctx: MutationCtx,
  result: RunResult,
  opts: {
    stepId: Id<"steps">;
  },
): Promise<RunResult> {
  if (result.kind !== "success") {
    return result;
  }
  const sizeError = checkReturnValueSize(result.returnValue as Value);
  if (!sizeError) {
    return result;
  }
  await ctx.scheduler.runAfter(0, internal.oversizedValues.store, {
    kind: "returnValue" as const,
    stepId: opts.stepId,
    value: result.returnValue,
  });
  return { kind: "failed", error: sizeError };
}

const vOversizedValueDoc = doc(schema, "oversizedValues");

export const vKind = v.union(v.literal("returnValue"), v.literal("args"));

export const store = internalAction({
  args: {
    kind: vKind,
    stepId: v.id("steps"),
    value: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const json = convexToJson(args.value as Value);
    const blob = new Blob([JSON.stringify(json)]);
    const storageId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.oversizedValues.save, {
      kind: args.kind,
      stepId: args.stepId,
      storageId,
    });
    return null;
  },
});

export const save = internalMutation({
  args: {
    kind: vKind,
    stepId: v.id("steps"),
    storageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const step = await ctx.db.get("steps", args.stepId);
    if (!step) {
      throw new Error(`Step not found: ${args.stepId}`);
    }
    const workflow = await ctx.db.get("workflows", step.workflowId);
    await ctx.db.insert("oversizedValues", {
      workflowId: step.workflowId,
      name: workflow?.name ?? "",
      kind: args.kind,
      stepId: args.stepId,
      storageId: args.storageId,
    });
    return null;
  },
});

export const get = internalQuery({
  args: {
    stepId: v.id("steps"),
  },
  returns: v.union(vOversizedValueDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"oversizedValues"> | null> => {
    return await ctx.db
      .query("oversizedValues")
      .withIndex("stepId", (q) => q.eq("stepId", args.stepId))
      .first();
  },
});

export const list = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  returns: vPaginationResult(vOversizedValueDoc),
  handler: async (ctx, args): Promise<PaginationResult<Doc<"oversizedValues">>> => {
    return await paginator(ctx.db, schema)
      .query("oversizedValues")
      .paginate(args.paginationOpts);
  },
});

export const read = action({
  args: {
    stepId: v.id("steps"),
  },
  returns: v.any(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: async (ctx, args): Promise<any> => {
    const record = await ctx.runQuery(internal.oversizedValues.get, {
      stepId: args.stepId,
    });
    if (!record) {
      throw new Error(
        `No oversized value found for step ${args.stepId}`,
      );
    }
    const blob = await ctx.storage.get(record.storageId);
    if (!blob) {
      throw new Error(`Storage blob not found: ${record.storageId}`);
    }
    return jsonToConvex(JSON.parse(await blob.text()));
  },
});

export const remove = action({
  args: {
    stepId: v.id("steps"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await ctx.runMutation(internal.oversizedValues.deleteRecord, {
      stepId: args.stepId,
    });
    return null;
  },
});

export const deleteRecord = internalMutation({
  args: {
    stepId: v.id("steps"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const record = await ctx.db
      .query("oversizedValues")
      .withIndex("stepId", (q) => q.eq("stepId", args.stepId))
      .first();
    if (record) {
      await ctx.storage.delete(record.storageId);
      await ctx.db.delete("oversizedValues", record._id);
    }
    return null;
  },
});
