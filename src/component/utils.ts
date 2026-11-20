import { type QueryCtx } from "./_generated/server.js";
import { createLogger, DEFAULT_LOG_LEVEL } from "./logging.js";

export async function getDefaultLogger(ctx: QueryCtx) {
  const config = await ctx.db.query("config").first();
  return createLogger(config?.logLevel ?? DEFAULT_LOG_LEVEL);
}
