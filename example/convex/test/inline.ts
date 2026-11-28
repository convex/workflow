import { WorkflowManager } from "@convex-dev/workflow";
import { v } from "convex/values";
import {
  customCtx,
  customMutation,
} from "convex-helpers/server/customFunctions";
import { Triggers } from "convex-helpers/server/triggers";
import type { DataModel } from "../_generated/dataModel.js";
import { components, internal } from "../_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server.js";

export const workflow = new WorkflowManager(components.workflow);

// ── Test 1: Sequential inline queries ─────────
// Results come back in order, one at a time.
export const sequentialInlineQueries = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ a: v.number(), b: v.number() }),
  })
  .handler(async (step, args) => {
    const a = await step.runQuery(
      internal.test.inline.getCounter,
      { key: args.key },
      { inline: true },
    );
    const b = await step.runQuery(
      internal.test.inline.getCounter,
      { key: args.key + "_other" },
      { inline: true },
    );
    return { a, b };
  });

// ── Test 2: Parallel inline queries ───────────
// Both pushed to channel before either is awaited.
// First run: batched, both resolve at once.
// Replay: resolved one-by-one from journal.
// resolveOrder should be ["a","b"] in both cases.
export const parallelInlineQueries = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({
      a: v.number(),
      b: v.number(),
      resolveOrder: v.array(v.string()),
    }),
  })
  .handler(async (step, args) => {
    const resolveOrder: string[] = [];
    const aPromise = step
      .runQuery(
        internal.test.inline.getCounter,
        { key: args.key },
        { inline: true },
      )
      .then((val) => {
        resolveOrder.push("a");
        return val;
      });
    const bPromise = step
      .runQuery(
        internal.test.inline.getCounter,
        { key: args.key + "_other" },
        { inline: true },
      )
      .then((val) => {
        resolveOrder.push("b");
        return val;
      });
    const [a, b] = await Promise.all([aPromise, bPromise]);
    return { a, b, resolveOrder };
  });

// ── Test 3: Promise.race between inline queries ──
// Checks which promise resolves first.
// Should be "a" in both first-run and replay paths.
export const raceInlineQueries = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ winner: v.string(), value: v.number() }),
  })
  .handler(async (step, args) => {
    const aPromise = step
      .runQuery(
        internal.test.inline.getCounter,
        { key: args.key },
        { inline: true },
      )
      .then((val) => ({ winner: "a", value: val }));
    const bPromise = step
      .runQuery(
        internal.test.inline.getCounter,
        { key: args.key + "_other" },
        { inline: true },
      )
      .then((val) => ({ winner: "b", value: val }));
    return await Promise.race([aPromise, bPromise]);
  });

// ── Test 4: Inline mutations ──────────────────
// Verifies mutations execute within the same transaction.
export const inlineMutations = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ first: v.number(), second: v.number() }),
  })
  .handler(async (step, args) => {
    const first = await step.runMutation(
      internal.test.inline.incrementCounter,
      { key: args.key },
      { inline: true },
    );
    const second = await step.runMutation(
      internal.test.inline.incrementCounter,
      { key: args.key },
      { inline: true },
    );
    return { first, second };
  });

// ── Test 6: Mixed inline + action ─────────────
// The query runs inline, while the action goes through
// workpool. Since not all steps complete inline, executor blocks.
export const mixedInlineAndAction = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({
      queryResult: v.number(),
      actionResult: v.string(),
    }),
  })
  .handler(async (step, args) => {
    const queryPromise = step.runQuery(
      internal.test.inline.getCounter,
      { key: args.key },
      { inline: true },
    );
    const actionPromise = step.runAction(internal.test.inline.someAction, {
      label: args.key,
    });
    const [queryResult, actionResult] = await Promise.all([
      queryPromise,
      actionPromise,
    ]);
    return { queryResult, actionResult };
  });

// ── Test 7: Dependent inline queries ──────────
// Second query uses result of first.
export const dependentInlineQueries = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ first: v.number(), second: v.number() }),
  })
  .handler(async (step, args) => {
    const first = await step.runQuery(
      internal.test.inline.getCounter,
      { key: args.key },
      { inline: true },
    );
    const second = await step.runQuery(
      internal.test.inline.getCounter,
      { key: first === 0 ? args.key + "_zero" : args.key + "_nonzero" },
      { inline: true },
    );
    return { first, second };
  });

// ── Test 8: transactionLimits error is catchable ──
// Runs an inline mutation with a transactionLimits cap so tight it must be
// exceeded (writing any document exceeds documentsWritten: 0). The resulting
// error is caught in the handler, and the workflow continues by running the
// same mutation again without limits. Requires Convex >= 1.41 to enforce.
export const catchTransactionLimit = workflow
  .define({
    args: { key: v.string() },
    returns: v.object({ caught: v.boolean(), finalValue: v.number() }),
  })
  .handler(async (step, args) => {
    let caught = false;
    try {
      await step.runMutation(
        internal.test.inline.incrementCounter,
        { key: args.key },
        { inline: true, transactionLimits: { documentsWritten: 0 } },
      );
    } catch (e) {
      caught = true;
      console.error(
        "caught transaction limit error:",
        e instanceof Error ? e.message : e,
      );
    }
    // Continue: run the same mutation again, this time without any limits.
    const finalValue = await step.runMutation(
      internal.test.inline.incrementCounter,
      { key: args.key },
      { inline: true },
    );
    return { caught, finalValue };
  });

// Run the workflow directly to validate manually, e.g.:
//   npx convex run test/inline:catchTransactionLimit '{"args":{"key":"foo"}}'
// then read its result with this status query.
export const catchTransactionLimitStatus = internalQuery({
  args: { workflowId: v.string() },
  handler: async (ctx, { workflowId }) => {
    return await workflow.status(ctx, workflowId as any);
  },
});

// ── Helper functions ──────────────────────────

export const getCounter = internalQuery({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const doc = await ctx.db
      .query("flows")
      .filter((q) => q.eq(q.field("in"), key))
      .first();
    return doc ? (doc.out as number) : 0;
  },
});

export const incrementCounter = internalMutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, { key }) => {
    const doc = await ctx.db
      .query("flows")
      .filter((q) => q.eq(q.field("in"), key))
      .first();
    const newVal = doc ? (doc.out as number) + 1 : 1;
    if (doc) {
      await ctx.db.patch("flows", doc._id, { out: newVal });
    } else {
      await ctx.db.insert("flows", {
        in: key,
        workflowId: "" as any,
        out: newVal,
      });
    }
    return newVal;
  },
});

export const someAction = internalAction({
  args: { label: v.string() },
  returns: v.string(),
  handler: async (_ctx, { label }) => {
    // TODO: use setTimeout after https://github.com/convex/convex-test/pull/78
    // await new Promise((resolve) => setTimeout(resolve, 500));
    return `action:${label}`;
  },
});

const callbackWorkflow = new WorkflowManager(components.workflow, {
  internalMutation,
});

const triggers = new Triggers<DataModel>();
triggers.register("flows", async (ctx, change) => {
  if (change.operation === "insert" && change.newDoc.in === "trigger") {
    await ctx.db.insert("flows", {
      in: "audit",
      workflowId: change.newDoc.workflowId,
      out: change.id,
    });
  }
});
const triggerWorkflow = new WorkflowManager(components.workflow, {
  internalMutation: customMutation(
    internalMutation,
    customCtx(triggers.wrapDB),
  ),
});
export const callbackTriggers = triggerWorkflow
  .define({
    args: {},
    returns: v.null(),
  })
  .handler(async (step) => {
    const derived = step.withOptions({});
    await derived.run(
      (ctx) =>
        ctx.db.insert("flows", {
          in: "trigger",
          workflowId: step.workflowId,
          out: null,
        }),
      { name: "insert" },
    );
    await step.sleep(1);
    return null;
  });

// Randomness inside a callback must not advance the replayed handler's PRNG.
export const callbackRandomReplay = callbackWorkflow
  .define({
    args: {},
    returns: v.object({
      value: v.number(),
      first: v.number(),
      later: v.number(),
    }),
  })
  .handler(async (step) => {
    const [first] = await Promise.all([
      step.run(() => Math.random(), { name: "randomA" }),
      step.run(
        async () => {
          await Promise.resolve();
          return Math.random();
        },
        { name: "randomB" },
      ),
    ]);
    const value = Math.random();
    await step.run(() => value, { name: "saveRandom", deps: { value } });
    await step.sleep(1);
    const later = await step.run(() => Math.random(), { name: "randomLater" });
    await step.sleep(1);
    return { value, first, later };
  });

// Callback writes and the result are persisted together and skipped on replay.
export const callbackWriteReplay = callbackWorkflow
  .define({
    args: {},
    returns: v.id("flows"),
  })
  .handler(async (step) => {
    const id = await step.run(
      async (ctx) =>
        ctx.db.insert("flows", {
          in: "callback",
          workflowId: step.workflowId,
          out: 1,
        }),
      { name: "insert" },
    );
    await step.sleep(1);
    return id;
  });

// A callback shares the outer transaction, including its error handling.
export const callbackPartialWrite = callbackWorkflow
  .define({
    args: { catchError: v.boolean() },
    returns: v.null(),
  })
  .handler(async (step, args) => {
    try {
      await step.run(
        async (ctx) => {
          await ctx.db.insert("flows", {
            in: "partial",
            workflowId: step.workflowId,
            out: 1,
          });
          throw new Error("after write");
        },
        { name: "writeThenThrow" },
      );
    } catch (error) {
      if (!args.catchError) throw error;
    }
    return null;
  });
