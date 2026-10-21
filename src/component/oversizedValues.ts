import {
  type Value,
  convexToJson,
  getConvexSize,
  jsonToConvex,
  v,
} from "convex/values";
import type { RunResult } from "@convex-dev/workpool";
import { mutation, type MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { getDefaultLogger } from "./utils.js";

export const MAX_RETURN_VALUE_SIZE = 800 << 10;
const PREVIEW_SIZE = 8 << 10;

function truncatedPreview(returnValue: Value): string {
  const json = JSON.stringify(convexToJson(returnValue));
  if (json.length <= PREVIEW_SIZE * 2) {
    return json;
  }
  return json.slice(0, PREVIEW_SIZE) + "..." + json.slice(-PREVIEW_SIZE);
}

export async function storeOversizedResult(
  ctx: MutationCtx,
  result: RunResult,
  opts: {
    stepId: Id<"steps">;
  },
): Promise<RunResult> {
  if (result.kind !== "success") {
    return result;
  }
  const returnValue = result.returnValue as Value;
  const size = getConvexSize(returnValue);
  if (size <= MAX_RETURN_VALUE_SIZE) {
    return result;
  }
  const sizeError = `Step return value too large (${size} bytes). Maximum is ${MAX_RETURN_VALUE_SIZE} bytes.`;
  const blob = new Blob([JSON.stringify(convexToJson(returnValue))], {
    type: "application/json",
  });
  const { filesWritten, fileWriteBytes } =
    await ctx.meta.getTransactionMetrics();
  if (filesWritten.remaining < 1 || blob.size > fileWriteBytes.remaining) {
    const console = await getDefaultLogger(ctx);
    console.warn(
      `Not storing oversized result of ${opts.stepId} (${blob.size} bytes) because the transaction has ${filesWritten.remaining} files and ${fileWriteBytes.remaining} file bytes remaining.`,
    );
    return {
      kind: "failed",
      error: `${sizeError} Preview: ${truncatedPreview(returnValue)}`,
    };
  }
  const step = await ctx.db.get("steps", opts.stepId);
  if (!step) {
    throw new Error(`Step not found: ${opts.stepId}`);
  }
  const workflow = await ctx.db.get("workflows", step.workflowId);
  const storageId = await ctx.storage.store(blob);
  await ctx.db.insert("oversizedValues", {
    workflowId: step.workflowId,
    name: workflow?.name ?? "",
    kind: "returnValue",
    stepId: opts.stepId,
    storageId,
  });
  return {
    kind: "failed",
    error: `${sizeError} Retrieve it with ctx.runMutation(components.workflow.oversizedValues.read, { stepId: "${opts.stepId}" }).`,
  };
}

export const read = mutation({
  args: {
    stepId: v.id("steps"),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<any> => {
    const record = await ctx.db
      .query("oversizedValues")
      .withIndex("stepId", (q) => q.eq("stepId", args.stepId))
      .unique();
    if (!record) {
      throw new Error(`No oversized value found for step ${args.stepId}`);
    }
    const blob = await ctx.storage.get(record.storageId);
    if (!blob) {
      throw new Error(`Storage blob not found: ${record.storageId}`);
    }
    return jsonToConvex(JSON.parse(await blob.text()));
  },
});

export const remove = mutation({
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
