import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";
import { logLevel } from "./logging.js";

export const init = internalMutation({
  args: {
    // Only forwarded to the workpool in convex.config.ts.
    maxParallelism: v.optional(v.number()),
    logLevel: v.optional(logLevel),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const config = await ctx.db.query("config").first();
    if (config?.logLevel === args.logLevel) {
      return null;
    }
    const desired =
      args.logLevel === undefined ? {} : { logLevel: args.logLevel };
    if (config) {
      await ctx.db.replace("config", config._id, desired);
    } else {
      await ctx.db.insert("config", desired);
    }
    return null;
  },
});
