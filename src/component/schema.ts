import { vResultValidator, vWorkIdValidator } from "@convex-dev/workpool";
import { deprecated, literals } from "convex-helpers/validators";
import { defineSchema, defineTable } from "convex/server";
import { type Infer, v } from "convex/values";
import { logLevel } from "./logging.js";

export const vOnComplete = v.object({
  fnHandle: v.string(), // mutation
  context: v.optional(v.any()),
});

const workflowObject = {
  name: v.optional(v.string()),
  workflowHandle: v.string(),
  args: v.any(),
  onComplete: v.optional(vOnComplete),
  logLevel: deprecated,
  startedAt: deprecated,
  state: deprecated,
  // undefined until it's completed
  runResult: v.optional(vResultValidator),

  // Internal execution status, used to totally order mutations.
  generationNumber: v.number(),
};

export const workflowDocument = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  ...workflowObject,
});
export type Workflow = Infer<typeof workflowDocument>;

const stepCommonFields = {
  name: v.string(),
  inProgress: v.boolean(),
  argsSize: v.number(),
  args: v.any(),
  runResult: v.optional(vResultValidator),
  startedAt: v.number(),
  completedAt: v.optional(v.number()),
};

export const step = v.union(
  v.object({
    kind: v.optional(v.literal("function")),
    functionType: literals("query", "mutation", "action"),
    handle: v.string(),
    workId: v.optional(vWorkIdValidator),
    ...stepCommonFields,
  }),
  v.object({
    kind: v.literal("workflow"),
    handle: v.string(),
    workflowId: v.optional(v.id("workflows")),
    ...stepCommonFields,
  }),
  v.object({
    kind: v.literal("event"),
    ...stepCommonFields,
    eventId: v.optional(v.id("events")),
    args: v.object({ eventId: v.optional(v.id("events")) }),
  }),
  v.object({
    kind: v.literal("sleep"),
    workId: v.optional(vWorkIdValidator),
    ...stepCommonFields,
  }),
);
export type Step = Infer<typeof step>;

const journalObject = {
  workflowId: v.id("workflows"),
  stepNumber: v.number(),
  step,
};

export const journalDocument = v.object({
  _id: v.string(),
  _creationTime: v.number(),
  ...journalObject,
});
export type JournalEntry = Infer<typeof journalDocument>;

export const event = {
  workflowId: v.id("workflows"),
  name: v.string(),
  state: v.union(
    v.object({
      kind: v.literal("created"),
    }),
    v.object({
      kind: v.literal("sent"),
      result: vResultValidator,
      sentAt: v.number(),
    }),
    v.object({
      kind: v.literal("waiting"),
      waitingAt: v.number(),
      stepId: v.id("steps"),
    }),
    v.object({
      kind: v.literal("consumed"),
      waitingAt: v.number(),
      sentAt: v.number(),
      consumedAt: v.number(),
      stepId: v.id("steps"),
    }),
  ),
};

export default defineSchema({
  config: defineTable({
    logLevel: v.optional(logLevel),
    maxParallelism: v.optional(v.number()),
  }),
  workflows: defineTable(workflowObject).index("name", ["name"]),
  steps: defineTable(journalObject)
    .index("workflow", ["workflowId", "stepNumber"])
    .index("inProgress", ["step.inProgress", "workflowId"]),
  events: defineTable(event).index("workflowId_state", [
    "workflowId",
    "state.kind",
  ]),
  onCompleteFailures: defineTable(
    v.union(
      v.object({
        workId: v.optional(vWorkIdValidator),
        workflowId: v.optional(v.string()),
        result: vResultValidator,
        context: v.any(),
      }),
      v.object({
        workflowId: v.id("workflows"),
        generationNumber: v.number(),
        runResult: vResultValidator,
        error: v.string(),
      }),
    ),
  ),
});
