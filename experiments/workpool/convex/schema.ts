import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Independent rows avoid introducing a shared completion-counter bottleneck.
  completions: defineTable({
    run: v.string(),
    index: v.number(),
    kind: v.string(),
    value: v.optional(v.number()),
    at: v.number(),
  }).index("by_run", ["run"]),
  writes: defineTable({
    run: v.string(),
    index: v.number(),
    step: v.number(),
  }).index("by_run", ["run"]),
});
