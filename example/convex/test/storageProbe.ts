// Minimal live repro, independent of workflow/workpool:
// npx convex run test/storageProbe:run
import { v } from "convex/values";
import { internal } from "../_generated/api.js";
import { internalAction, internalMutation } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";

export const store = internalMutation({
  args: {},
  handler: async (ctx): Promise<Id<"_storage">> =>
    ctx.storage.store(
      new Blob(["mutation storage probe"], { type: "text/plain" }),
    ),
});

export const read = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args): Promise<string | null> => {
    const blob = await ctx.storage.get(args.storageId);
    return blob ? await blob.text() : null;
  },
});

export const remove = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => ctx.storage.delete(args.storageId),
});

export const run = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    read?: string;
    mutationRead?: string | null;
    error?: string;
    httpStatus?: number;
  }> => {
    const storageId = await ctx.runMutation(
      internal.test.storageProbe.store,
      {},
    );
    try {
      const blob = await ctx.storage.get(storageId);
      const mutationRead = await ctx.runMutation(
        internal.test.storageProbe.read,
        { storageId },
      );
      const url = await ctx.storage.getUrl(storageId);
      const response = url ? await fetch(url) : null;
      return {
        read: blob ? await blob.text() : "missing blob",
        mutationRead,
        httpStatus: response?.status,
      };
    } catch (error) {
      const url = await ctx.storage.getUrl(storageId);
      const response = url ? await fetch(url) : null;
      return { error: String(error), httpStatus: response?.status };
    } finally {
      await ctx.runMutation(internal.test.storageProbe.remove, { storageId });
    }
  },
});
