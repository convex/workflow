import { defineTable, defineSchema } from "convex/server";
import { v } from "convex/values";
import { vWorkflowId } from "@convex-dev/workflow";

export default defineSchema({
  flows: defineTable({
    in: v.string(),
    workflowId: vWorkflowId,
    out: v.any(),
  }).index("workflowId", ["workflowId"]),
  // Side effects recorded by the step functions in proptest.ts.
  proptestEffects: defineTable({
    kind: v.union(
      v.literal("mutation"),
      v.literal("attempt"),
      v.literal("complete"),
    ),
    key: v.string(),
    result: v.optional(v.any()),
  }).index("kind_key", ["kind", "key"]),
});
