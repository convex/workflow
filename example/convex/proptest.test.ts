/// <reference types="vite/client" />

// Property test for a whole workflow: fast-check generates a list of `Op`s
// (see proptest.ts) and the test runs it with `runOps` under convex-test,
// then checks it against `evaluate` below, a model of what the ops should do.
//
// The checks are the workflow's final status and result, the one onComplete
// call and its result, and how many times each mutation committed and each
// action attempt ran. When a parallel group fails, its other branches may
// still be running, and how far they get depends on timing, so for those the
// model gives an upper bound instead of an exact count.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import {
  getStatus,
  listSteps,
  sendEvent,
  type EventId,
  type WorkflowId,
} from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { initConvexTest } from "./setup.test";
import { workflow } from "./example";
import type { Limit, Op } from "./proptest";
import { evaluateList, type Expected } from "./proptestModel";
import { assignKeys, opArb } from "./proptestGen";

const NUM_RUNS = Number(process.env.PROPTEST_RUNS ?? 100);
// finishAllScheduledFunctions stops after 100 passes by default. A big
// workflow under maxParallelism 1 runs its steps one at a time and can
// need more, which is slow but not stuck.
const MAX_ITERATIONS = 5000;
// Size knobs for longer searches: PROPTEST_WIDTH caps each nested op list
// (Promise.all groups, child workflows), PROPTEST_LENGTH the top-level list,
// PROPTEST_DEPTH is fast-check's depthSize, PROPTEST_SEED fixes the seed.
const WIDTH = Number(process.env.PROPTEST_WIDTH ?? 3);
const LENGTH = Number(process.env.PROPTEST_LENGTH ?? 4);
const DEPTH = (process.env.PROPTEST_DEPTH ?? "small") as fc.DepthSize;
const SEED = process.env.PROPTEST_SEED
  ? Number(process.env.PROPTEST_SEED)
  : undefined;

type ExtWait = Extract<Op, { kind: "extWait" }>;

// Every extWait in the ops, by key. `early` is cleared inside child
// workflows, since the test only knows the top-level workflow's ID up front.
function extWaits(
  ops: Op[],
  inChild = false,
  out = new Map<string, ExtWait>(),
): Map<string, ExtWait> {
  for (const op of ops) {
    switch (op.kind) {
      case "extWait":
        out.set(op.key, { ...op, early: op.early && !inChild });
        break;
      case "parallel":
        extWaits(op.ops, inChild, out);
        break;
      case "child":
        extWaits(op.ops, true, out);
        break;
      case "try":
        extWaits([op.op], inChild, out);
        break;
    }
  }
  return out;
}

const RUN_OPS = {
  default: internal.proptest.runOps,
  p1: internal.proptest.runOpsP1,
  p2: internal.proptest.runOpsP2,
  p3: internal.proptest.runOpsP3,
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test(
  "a generated workflow matches the model",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          opArb({ hang: false, ext: true, width: WIDTH, depth: DEPTH }),
          { minLength: 1, maxLength: LENGTH },
        ),
        fc.constantFrom<Limit>("default", "p1", "p2", "p3"),
        async (generated, limit) => {
          const ops = assignKeys(generated);
          const exp: Expected = { effects: new Map() };
          const outcome = evaluateList(ops, exp);
          const ext = extWaits(ops);

          vi.clearAllTimers();
          const t = initConvexTest();
          const workflowId = await t.run((ctx) =>
            workflow.start(
              ctx,
              RUN_OPS[limit],
              { ops, limit },
              { onComplete: internal.proptest.onComplete, context: null },
            ),
          );
          const sent = new Set<string>();
          const send = (
            target: { workflowId: WorkflowId; name: string } | { id: EventId },
            op: ExtWait,
          ) =>
            t.run((ctx) =>
              sendEvent(ctx, components.workflow, {
                ...target,
                ...(op.error
                  ? { error: `error ${op.key}` }
                  : { value: op.key }),
              } as Parameters<typeof sendEvent>[2]),
            );
          // Early sends go to the top-level workflow, so only top-level waits
          // can be early; `extWaits` clears `early` inside child workflows.
          for (const op of ext.values()) {
            if (op.early) {
              await send({ workflowId, name: op.key }, op);
              sent.add(op.key);
            }
          }
          // Each pass runs every timer and scheduled function that exists at
          // the time, then answers each external wait that has started.
          for (let i = 0; i < 200; i++) {
            await t.finishAllScheduledFunctions(
              vi.runAllTimers,
              MAX_ITERATIONS,
            );
            const s = await t.run((ctx) =>
              getStatus(ctx, components.workflow, workflowId),
            );
            if (s.type !== "inProgress") break;
            const waiting = await (t as any).runInComponent(
              "workflow",
              async (ctx: any) =>
                (await ctx.db.query("events").collect()).filter(
                  (e: any) => e.state.kind === "waiting",
                ),
            );
            let progressed = false;
            for (const e of waiting) {
              const op = ext.get(e.name);
              if (!op || sent.has(op.key)) continue;
              await send(
                op.byId
                  ? { id: e._id }
                  : { workflowId: e.workflowId, name: op.key },
                op,
              );
              sent.add(op.key);
              progressed = true;
            }
            if (!progressed) break;
          }

          const status = await t.run((ctx) =>
            getStatus(ctx, components.workflow, workflowId),
          );
          if (outcome.ok) {
            expect(status).toEqual({
              type: "completed",
              result: outcome.value,
            });
          } else {
            expect(status.type).toBe("failed");
          }

          // Once the root ends, endWorkflow has ended everything under it:
          // every workflow (the root and each child) has a result, no step
          // anywhere is in progress, and no event is still waiting. Checked
          // before the late sends below, which could otherwise close a
          // leftover wait and hide it.
          const leftovers = await (t as any).runInComponent(
            "workflow",
            async (ctx: any) => ({
              running: (await ctx.db.query("workflows").collect())
                .filter((w: any) => w.runResult === undefined)
                .map((w: any) => w._id),
              steps: (await ctx.db.query("steps").collect())
                .filter((s: any) => s.step.inProgress)
                .map((s: any) => `${s.step.kind}:${s.step.name}`),
              events: (await ctx.db.query("events").collect())
                .filter((e: any) => e.state.kind === "waiting")
                .map((e: any) => e.name),
            }),
          );
          expect(leftovers, "left running after the workflow ended").toEqual({
            running: [],
            steps: [],
            events: [],
          });

          // A send by name after the workflow ended doesn't throw and doesn't
          // change its status.
          for (const op of ext.values()) {
            await send({ workflowId, name: op.key }, op);
          }
          await t.finishAllScheduledFunctions(vi.runAllTimers);
          expect(
            await t.run((ctx) =>
              getStatus(ctx, components.workflow, workflowId),
            ),
          ).toEqual(status);

          const rows = await t.run((ctx) =>
            ctx.db.query("proptestEffects").collect(),
          );
          const completions = rows.filter((r) => r.kind === "complete");
          expect(completions).toHaveLength(1);
          expect(completions[0].key).toBe(workflowId);
          if (outcome.ok) {
            expect(completions[0].result).toEqual({
              kind: "success",
              returnValue: outcome.value,
            });
          } else {
            expect(completions[0].result.kind).toBe("failed");
          }

          const counts = new Map<string, number>();
          for (const r of rows) {
            if (r.kind === "complete") continue;
            counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
          }
          for (const [key, count] of counts) {
            const e = exp.effects.get(key);
            expect(e, `rows for ${key}, which should never run`).toBeDefined();
            expect(rows.find((r) => r.key === key)!.kind).toBe(e!.kind);
            if (e!.exact) {
              expect(count, `rows for ${key}`).toBe(e!.count);
            } else {
              expect(count, `rows for ${key}`).toBeLessThanOrEqual(e!.count);
            }
          }
          for (const [key, e] of exp.effects) {
            if (e.exact && e.count > 0) {
              expect(counts.get(key) ?? 0, `rows for ${key}`).toBe(e.count);
            }
          }

          // The workpool behind the component has no job left running or
          // queued. A leftover "running" job keeps its loop polling forever.
          const pool = await (t as any).runInComponent(
            "workflow/workpool",
            async (ctx: any) => ({
              running: (await ctx.db.query("internalState").collect()).flatMap(
                (s: any) => s.running,
              ),
              work: (await ctx.db.query("work").collect()).length,
              pendingStart: (await ctx.db.query("pendingStart").collect())
                .length,
              pendingCompletion: (
                await ctx.db.query("pendingCompletion").collect()
              ).length,
            }),
          );
          expect(pool, "workpool state").toEqual({
            running: [],
            work: 0,
            pendingStart: 0,
            pendingCompletion: 0,
          });
        },
      ),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  },
  10 * 60_000,
);

// Found by the property test. With maxParallelism 1 the executor starts the
// timed wait in the same replay that sees the mutation fail, then
// workflow.complete fails the workflow. The step used to stay in progress
// forever; endWorkflow now closes it as canceled when the workflow fails,
// and its event too, so the timeout that fires later changes nothing.
test("a timed wait started by a failing replay ends with its workflow", async () => {
  vi.clearAllTimers();
  const t = initConvexTest();
  const ops: Op[] = [
    {
      kind: "parallel",
      ops: [
        { kind: "mutation", key: "m", inline: false, fail: true },
        { kind: "query", value: 0, inline: false },
        { kind: "event", key: "e", send: false, timeout: 1000 },
      ],
    },
  ];
  const workflowId = await t.run((ctx) =>
    workflow.start(ctx, internal.proptest.runOpsP1, { ops, limit: "p1" }),
  );
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const status = await t.run((ctx) =>
    getStatus(ctx, components.workflow, workflowId),
  );
  expect(status.type).toBe("failed");
  const steps = await t.run((ctx) =>
    listSteps(ctx, components.workflow, workflowId, {
      paginationOpts: { cursor: null, numItems: 100 },
    }),
  );
  const timed = steps.page.find((s) => s.name === "e");
  expect(timed?.completedAt).toBeDefined();
  expect(timed?.runResult).toEqual({ kind: "canceled" });
  const events = await (
    t as unknown as {
      runInComponent: (
        path: string,
        fn: (ctx: any) => Promise<{ state: { kind: string } }[]>,
      ) => Promise<{ state: { kind: string } }[]>;
    }
  ).runInComponent("workflow", (ctx) => ctx.db.query("events").collect());
  expect(events.map((e) => e.state.kind)).toEqual(["canceled"]);
});
