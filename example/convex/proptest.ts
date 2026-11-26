// Functions for proptest.test.ts. `runOps` runs a generated list of `Op`s
// (steps, parallel groups, caught errors, child workflows, events) and
// returns one result per op. The step functions below record each side
// effect in the `proptestEffects` table, so the test can count how many
// times each mutation committed and each action attempt ran.

import { v } from "convex/values";
import {
  createEvent,
  sendEvent,
  vResultValidator,
  vWorkflowId,
  WorkflowManager,
  type EventId,
  type WorkflowCtx,
} from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { workflow } from "./example";

export type Op =
  | { kind: "query"; value: number; inline: boolean }
  | { kind: "mutation"; key: string; inline: boolean; fail: boolean }
  // Fails its first `failTimes` attempts. Gets `maxAttempts` tries in all.
  | { kind: "action"; key: string; failTimes: number; maxAttempts: number }
  | { kind: "sleep"; ms: number }
  | { kind: "parallel"; ops: Op[] }
  | { kind: "try"; op: Op }
  | { kind: "child"; ops: Op[] }
  // If `send`, a mutation step sends the event to this workflow before the
  // wait starts. Without `send` the wait must have a `timeout`, or it would
  // never end.
  | { kind: "event"; key: string; send: boolean; timeout?: number }
  // Throws from the handler itself, with no step. Beside a step in a
  // `parallel`, the workflow fails while that step is still running.
  | { kind: "throw" }
  // A query returning a string of `kb` KiB. The op returns its length, so
  // only the step's journal entry holds the big value.
  | { kind: "big"; kb: number; inline: boolean }
  // Waits for an event that the test sends from outside the workflow, with
  // the value `key` or, if `error`, an error. By ID, a mutation step creates
  // the event first and the test sends to that ID. By name with `early`, the
  // test sends right after starting the workflow, before the wait exists.
  | {
      kind: "extWait";
      key: string;
      byId: boolean;
      error: boolean;
      early: boolean;
    };

// One `runOps` per workpool maxParallelism setting the test tries. The
// setting belongs to the WorkflowManager, so each needs its own. Child
// workflows run with the same one as their parent.
const managers = {
  default: workflow,
  p1: new WorkflowManager(components.workflow, {
    workpoolOptions: { maxParallelism: 1 },
  }),
  p2: new WorkflowManager(components.workflow, {
    workpoolOptions: { maxParallelism: 2 },
  }),
  p3: new WorkflowManager(components.workflow, {
    workpoolOptions: { maxParallelism: 3 },
  }),
};
export type Limit = keyof typeof managers;

function runOpsRef(limit: Limit) {
  return {
    default: internal.proptest.runOps,
    p1: internal.proptest.runOpsP1,
    p2: internal.proptest.runOpsP2,
    p3: internal.proptest.runOpsP3,
  }[limit];
}

async function runOp(
  step: WorkflowCtx,
  op: Op,
  limit: Limit,
): Promise<unknown> {
  switch (op.kind) {
    case "query":
      return step.runQuery(
        internal.proptest.echo,
        { value: op.value },
        { inline: op.inline },
      );
    case "mutation":
      return step.runMutation(
        internal.proptest.effect,
        { key: op.key, fail: op.fail },
        { inline: op.inline },
      );
    case "action":
      return step.runAction(
        internal.proptest.flaky,
        { key: op.key, failTimes: op.failTimes },
        {
          retry:
            op.maxAttempts > 1
              ? { maxAttempts: op.maxAttempts, initialBackoffMs: 10, base: 1 }
              : false,
        },
      );
    case "sleep":
      await step.sleep(op.ms);
      return null;
    case "parallel":
      return Promise.all(op.ops.map((o) => runOp(step, o, limit)));
    case "try":
      try {
        return { ok: await runOp(step, op.op, limit) };
      } catch {
        return { caught: true };
      }
    case "child":
      return step.runWorkflow(runOpsRef(limit), { ops: op.ops, limit });
    case "throw":
      throw new Error("handler threw");
    case "big": {
      const s = await step.runQuery(
        internal.proptest.bigString,
        { kb: op.kb },
        { inline: op.inline },
      );
      return s.length;
    }
    case "extWait": {
      if (op.byId) {
        const id = await step.runMutation(internal.proptest.makeEvent, {
          workflowId: step.workflowId,
          name: op.key,
        });
        return step.awaitEvent({ id: id as EventId<string> });
      }
      return step.awaitEvent({ name: op.key, validator: v.string() });
    }
    case "event":
      if (op.send) {
        await step.runMutation(internal.proptest.sendSelf, {
          workflowId: step.workflowId,
          name: op.key,
          value: op.key,
        });
      }
      return op.timeout === undefined
        ? step.awaitEvent({ name: op.key, validator: v.string() })
        : step.awaitEvent({
            name: op.key,
            validator: v.string(),
            timeout: op.timeout,
          });
  }
}

function defineRunOps(limit: Limit) {
  return managers[limit]
    .define({ args: { ops: v.any(), limit: v.optional(v.string()) } })
    .handler(async (step, args): Promise<unknown[]> => {
      const results: unknown[] = [];
      for (const op of args.ops as Op[]) {
        results.push(await runOp(step, op, limit));
      }
      return results;
    });
}

export const runOps = defineRunOps("default");
export const runOpsP1 = defineRunOps("p1");
export const runOpsP2 = defineRunOps("p2");
export const runOpsP3 = defineRunOps("p3");

export const makeEvent = internalMutation({
  args: { workflowId: vWorkflowId, name: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await createEvent(ctx, components.workflow, args);
  },
});

export const bigString = internalQuery({
  args: { kb: v.number() },
  returns: v.string(),
  handler: async (_ctx, args) => "x".repeat(args.kb * 1024),
});

export const echo = internalQuery({
  args: { value: v.number() },
  returns: v.number(),
  handler: async (_ctx, args) => args.value,
});

// Throwing rolls back the insert, so a failed mutation leaves no row.
export const effect = internalMutation({
  args: { key: v.string(), fail: v.boolean() },
  returns: v.string(),
  handler: async (ctx, args) => {
    await ctx.db.insert("proptestEffects", { kind: "mutation", key: args.key });
    if (args.fail) throw new Error(`mutation ${args.key} failed`);
    return args.key;
  },
});

// Each attempt commits an "attempt" row through its own mutation before it
// decides whether to throw, so failed attempts are counted too.
export const flaky = internalAction({
  args: { key: v.string(), failTimes: v.number() },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const attempt: number = await ctx.runMutation(
      internal.proptest.recordAttempt,
      { key: args.key },
    );
    if (attempt <= args.failTimes) {
      throw new Error(`action ${args.key} attempt ${attempt} failed`);
    }
    return args.key;
  },
});

export const recordAttempt = internalMutation({
  args: { key: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    await ctx.db.insert("proptestEffects", { kind: "attempt", key: args.key });
    const rows = await ctx.db
      .query("proptestEffects")
      .withIndex("kind_key", (q) => q.eq("kind", "attempt").eq("key", args.key))
      .collect();
    return rows.length;
  },
});

export const sendSelf = internalMutation({
  args: { workflowId: vWorkflowId, name: v.string(), value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await sendEvent(ctx, components.workflow, {
      workflowId: args.workflowId,
      name: args.name,
      value: args.value,
    });
    return null;
  },
});

export const onComplete = internalMutation({
  args: { workflowId: vWorkflowId, result: vResultValidator, context: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("proptestEffects", {
      kind: "complete",
      key: args.workflowId,
      result: args.result,
    });
    return null;
  },
});

// Passes Date.now() and Math.random() into each step's args. The journal
// compares step args on replay, so if either differed between replays the
// workflow would fail with "Journal entry mismatch". Returns the values the
// final replay saw, which the test compares with the recorded args.
export const envDeterminism = workflow
  .define({ args: { steps: v.number(), sleepMs: v.number() } })
  .handler(async (step, args): Promise<{ t: number; r: number }[]> => {
    const seen: { t: number; r: number }[] = [];
    for (let i = 0; i < args.steps; i++) {
      const t = Date.now();
      const r = Math.random();
      seen.push({ t, r });
      await Promise.all([
        step.runMutation(internal.proptest.effect, {
          key: `env${i}:${t}:${r}`,
          fail: false,
        }),
        step.sleep(args.sleepMs),
      ]);
    }
    return seen;
  });
