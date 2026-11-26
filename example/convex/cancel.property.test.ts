/// <reference types="vite/client" />

// Property test for canceling a workflow partway through. fast-check
// generates ops for `runOps` (proptest.ts), how long to let it run, and
// which workflow to cancel: the root, or a child workflow found through
// listSteps. Then it runs everything to the end and checks the invariants
// in `check` below.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import {
  cancel,
  getStatus,
  listSteps,
  sendEvent,
  type WorkflowId,
  type WorkflowStep,
} from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { initConvexTest } from "./setup.test";
import { workflow } from "./example";
import type { Op } from "./proptest";
import { assignKeys, opArb } from "./proptestGen";

type T = ReturnType<typeof initConvexTest>;

const NUM_RUNS = Number(process.env.PROPTEST_RUNS ?? 100);
const TICK = 100;

type Node = {
  id: WorkflowId;
  parent: WorkflowId | null;
  steps: WorkflowStep[];
};

// The root workflow and every child workflow under it, found through the
// `nestedWorkflowId` of each "workflow" step.
async function tree(t: T, root: WorkflowId): Promise<Node[]> {
  const nodes: Node[] = [];
  const queue: { id: WorkflowId; parent: WorkflowId | null }[] = [
    { id: root, parent: null },
  ];
  while (queue.length > 0) {
    const { id, parent } = queue.shift()!;
    const steps = (
      await t.run((ctx) =>
        listSteps(ctx, components.workflow, id, {
          paginationOpts: { cursor: null, numItems: 1000 },
        }),
      )
    ).page;
    nodes.push({ id, parent, steps });
    for (const s of steps) {
      if (s.kind === "workflow" && s.nestedWorkflowId) {
        queue.push({ id: s.nestedWorkflowId, parent: id });
      }
    }
  }
  return nodes;
}

function status(t: T, id: WorkflowId) {
  return t.run((ctx) => getStatus(ctx, components.workflow, id));
}

function eventKeys(ops: Op[]): string[] {
  return ops.flatMap((op): string[] => {
    switch (op.kind) {
      case "event":
        return [op.key];
      case "parallel":
      case "child":
        return eventKeys(op.ops);
      case "try":
        return eventKeys([op.op]);
      default:
        return [];
    }
  });
}

// Workflows at or under `id`.
function subtree(nodes: Node[], id: WorkflowId): Set<WorkflowId> {
  const ids = new Set<WorkflowId>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parent && ids.has(n.parent) && !ids.has(n.id)) {
        ids.add(n.id);
        grew = true;
      }
    }
  }
  return ids;
}

async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test(
  "canceling a generated workflow partway through",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb({ hang: true }), { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 80 }),
        fc.oneof(
          fc.constant({ root: true as const }),
          fc.record({ root: fc.constant(false as const), pick: fc.nat(20) }),
        ),
        fc.boolean(),
        async (generated, ticks, target, twice) => {
          const ops = assignKeys(generated);
          vi.clearAllTimers();
          const t = initConvexTest();
          const rootId = await t.run((ctx) =>
            workflow.start(
              ctx,
              internal.proptest.runOps,
              { ops },
              { onComplete: internal.proptest.onComplete, context: null },
            ),
          );
          for (let i = 0; i < ticks; i++) {
            vi.advanceTimersByTime(TICK);
            await t.finishInProgressScheduledFunctions();
          }

          const before = await tree(t, rootId);
          const children = before.filter((n) => n.parent !== null);
          const targetId =
            target.root || children.length === 0
              ? rootId
              : children[target.pick % children.length].id;
          const beforeStatus = new Map<WorkflowId, string>();
          for (const n of before) {
            beforeStatus.set(n.id, (await status(t, n.id)).type);
          }
          const wasRunning = beforeStatus.get(targetId) === "inProgress";
          const beforeSteps = new Set(
            before.flatMap((n) => n.steps.map((s) => s.stepId)),
          );

          // Effect rows that exist before the cancel (see the attempt check).
          const rowsBeforeCancel = new Set(
            (
              await t.run((ctx) => ctx.db.query("proptestEffects").collect())
            ).map((r) => r._id),
          );
          const firstError = await errorOf(
            t.run((ctx) => cancel(ctx, components.workflow, targetId)),
          );
          const secondError = twice
            ? await errorOf(
                t.run((ctx) => cancel(ctx, components.workflow, targetId)),
              )
            : null;

          // Right after cancel, before anything else runs: every workflow in
          // the canceled part of the tree that was running has ended, with
          // no step still in progress and no event still waiting
          // (endWorkflow closes them in the cancel's own transaction).
          const problems: string[] = [];
          if (wasRunning) {
            const ids = [...subtree(before, targetId)].filter(
              (id) => beforeStatus.get(id) === "inProgress",
            );
            const open = await (t as any).runInComponent(
              "workflow",
              async (ctx: any) => {
                const out: string[] = [];
                for (const id of ids) {
                  const w = await ctx.db.get("workflows", id);
                  if (w?.runResult === undefined) out.push(`${id} running`);
                  for (const st of await ctx.db
                    .query("steps")
                    .withIndex("workflow", (q: any) => q.eq("workflowId", id))
                    .collect()) {
                    if (st.step.inProgress) {
                      out.push(
                        `${id} step ${st.step.kind}:${st.step.name} open`,
                      );
                    }
                  }
                  for (const e of await ctx.db.query("events").collect()) {
                    if (e.workflowId === id && e.state.kind === "waiting") {
                      out.push(`${id} event ${e.name} waiting`);
                    }
                  }
                }
                return out;
              },
            );
            problems.push(...open.map((o: string) => `after cancel: ${o}`));
            // A second cancel of a workflow that has ended is refused.
            if (
              twice &&
              !firstError &&
              !/not running/.test(secondError ?? "")
            ) {
              problems.push(`second cancel returned ${secondError ?? "ok"}`);
            }
          }

          // Every step that has ended, with its result, right after cancel.
          // finishStep (src/component/finish.ts) ignores results for a step
          // that already ended, so late sends and jobs the workpool had
          // already launched must leave these unchanged.
          const endedSteps = async () =>
            new Map<string, string>(
              await (t as any).runInComponent("workflow", async (ctx: any) =>
                (await ctx.db.query("steps").collect())
                  .filter((st: any) => !st.step.inProgress)
                  .map((st: any) => [
                    st._id,
                    JSON.stringify(st.step.runResult),
                  ]),
              ),
            );
          const endedAfterCancel = await endedSteps();

          // Sends after cancel, to every workflow in the canceled part of
          // the tree, for every event name. None should throw.
          const sendErrors: string[] = [];
          for (const id of subtree(before, targetId)) {
            for (const key of eventKeys(ops)) {
              const err = await errorOf(
                t.run((ctx) =>
                  sendEvent(ctx, components.workflow, {
                    workflowId: id,
                    name: key,
                    value: "after-cancel",
                  }),
                ),
              );
              if (err) sendErrors.push(`${key} -> ${id}: ${err}`);
            }
          }

          const idleError = await errorOf(
            t.finishAllScheduledFunctions(vi.runAllTimers),
          );

          const after = await tree(t, rootId);
          const canceled = subtree(after, targetId);
          const finalStatus = new Map<WorkflowId, string>();
          for (const n of after) {
            finalStatus.set(n.id, (await status(t, n.id)).type);
          }

          if (idleError) problems.push(`scheduler never idle: ${idleError}`);
          const endedAtIdle = await endedSteps();
          for (const [id, result] of endedAfterCancel) {
            const later = endedAtIdle.get(id);
            if (later !== undefined && later !== result) {
              problems.push(
                `ended step ${id} changed from ${result} to ${later}`,
              );
            }
          }
          if (wasRunning && firstError) {
            problems.push(`cancel of a running workflow threw: ${firstError}`);
          }
          if (wasRunning && finalStatus.get(targetId) !== "canceled") {
            problems.push(
              `target ended ${finalStatus.get(targetId)}, not canceled`,
            );
          }
          for (const n of after) {
            if (!canceled.has(n.id)) continue;
            // A child that was running when an ancestor was canceled ends
            // canceled too.
            if (
              n.id !== targetId &&
              wasRunning &&
              beforeStatus.get(n.id) === "inProgress" &&
              finalStatus.get(n.id) !== "canceled"
            ) {
              problems.push(`child ${n.id} ended ${finalStatus.get(n.id)}`);
            }
            if (wasRunning) {
              if (!beforeStatus.has(n.id)) {
                problems.push(`child workflow ${n.id} started after cancel`);
              }
              for (const s of n.steps) {
                // Compares step IDs, not startedAt: convex-test stamps steps a
                // millisecond or so ahead of the fake Date.now().
                if (!beforeSteps.has(s.stepId)) {
                  problems.push(
                    `step ${s.name} (#${s.stepNumber}) of ${n.id} started after cancel`,
                  );
                }
              }
            }
          }
          for (const n of after) {
            if (finalStatus.get(n.id) === "inProgress") continue;
            for (const s of n.steps) {
              if (s.completedAt === undefined) {
                problems.push(
                  `${finalStatus.get(n.id)} workflow ${n.id} has step ${s.kind}:${s.name} still in progress`,
                );
              }
            }
          }
          problems.push(
            ...sendErrors.map((e) => `send after cancel threw: ${e}`),
          );

          const rows = await t.run((ctx) =>
            ctx.db.query("proptestEffects").collect(),
          );
          const completions = rows.filter((r) => r.kind === "complete");
          const rootStatus = finalStatus.get(rootId)!;
          const expectedCompletions = rootStatus === "inProgress" ? 0 : 1;
          if (completions.length !== expectedCompletions) {
            problems.push(
              `root ${rootStatus} but onComplete ran ${completions.length} times`,
            );
          } else if (completions.length === 1) {
            const kind = completions[0].result.kind;
            const want = {
              completed: "success",
              failed: "failed",
              canceled: "canceled",
            }[rootStatus];
            if (kind !== want) {
              problems.push(`root ${rootStatus} but onComplete got ${kind}`);
            }
          }
          // After a root cancel, each action runs at most one more attempt:
          // one the workpool had already launched can't be stopped
          // (workpool.cancel only stops jobs that haven't started), but no
          // retry may start after it. Rows are compared by ID, not
          // _creationTime: convex-test stamps rows a little ahead of the
          // fake clock, so a row from before the cancel can look later.
          if (targetId === rootId && wasRunning) {
            const late = new Map<string, number>();
            for (const r of rows) {
              if (r.kind === "attempt" && !rowsBeforeCancel.has(r._id)) {
                late.set(r.key, (late.get(r.key) ?? 0) + 1);
              }
            }
            for (const [key, n] of late) {
              if (n > 1) {
                problems.push(`action ${key} ran ${n} attempts after cancel`);
              }
            }
          }

          const wp = await (t as any).runInComponent(
            "workflow/workpool",
            async (ctx: any) => ({
              running:
                (await ctx.db.query("internalState").first())?.running ?? [],
              pendingStart: await ctx.db.query("pendingStart").collect(),
              pendingCompletion: await ctx.db
                .query("pendingCompletion")
                .collect(),
            }),
          );
          if (
            !idleError &&
            (wp.running.length ||
              wp.pendingStart.length ||
              wp.pendingCompletion.length)
          ) {
            problems.push(
              `workpool left running=${wp.running.length} pendingStart=${wp.pendingStart.length} pendingCompletion=${wp.pendingCompletion.length}`,
            );
          }

          expect(
            problems,
            JSON.stringify({
              targetIsRoot: targetId === rootId,
              wasRunning,
              firstError,
              secondError,
            }),
          ).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  },
  10 * 60_000,
);
