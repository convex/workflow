/// <reference types="vite/client" />

// Property test for step.awaitEvent by name, with and without a timeout.
//
// fast-check generates a list of steps for the runScript workflow in
// timedEvents.ts (sleeps, timed waits, untimed waits) and the times at which
// the test calls sendEvent by name. `simulate` below is a small model of the
// rules in src/component/event.ts. The test runs the real component under
// convex-test with fake timers and expects the workflow's result to equal the
// model's.
//
// The model treats every step change as instant. The real component takes a
// few scheduler runs to start the next step, so a send that lands right at a
// step change could go either way. All durations are multiples of UNIT and
// `simulate` rejects (fc.pre) any run where a send is within MARGIN of a step
// change it didn't cause.

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import { getStatus, sendEvent, type WorkflowId } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { initConvexTest } from "./setup.test";
import { workflow } from "./example";

type T = ReturnType<typeof initConvexTest>;

const UNIT = 10_000;
const MARGIN = 2_000;
// Fake time moves in TICK steps, running scheduled functions after each one.
// See `advance` in timedEvents.test.ts for why it can't jump straight ahead.
const TICK = 100;
const NUM_RUNS = Number(process.env.PROPTEST_RUNS ?? 200);

type Step = { kind: "sleep"; units: number } | { kind: "wait"; units?: number };
type Send = { at: number; value: string };

// One row of the component's "events" table, as far as the rules care.
type EventRecord = {
  timed: boolean;
  state: "sent" | "waiting" | "consumed" | "timedOut";
  value?: string;
};

type Model = {
  results: unknown[];
  // The sends the test makes, in time order: the generated ones, then one
  // "flush" send at a time while the workflow is stuck in an untimed wait.
  sends: Send[];
  completedAt: number;
  // False if a send lands too close to a step change to predict.
  predictable: boolean;
};

function simulate(steps: Step[], generated: Send[]): Model {
  const sends = [...generated].sort((a, b) => a.at - b.at);
  const records: EventRecord[] = [];
  const results: unknown[] = [];
  // Each step change, and the index of the send that caused it (if any).
  const changes: { at: number; cause: number | null }[] = [];
  let stepIndex = 0;
  let completedAt: number | null = null;
  // The running step. A field on an object rather than a `let`, because
  // TypeScript doesn't see `startStep` and `send` assign a `let`.
  const cur: {
    active:
      | { kind: "sleep"; until: number }
      | { kind: "wait"; record: EventRecord; deadline?: number }
      | null;
  } = { active: null };

  // Oldest stored send, as findEvent(..., ["sent"]) returns it.
  const oldestSent = () => records.find((r) => r.state === "sent");

  function startStep(at: number, cause: number | null) {
    changes.push({ at, cause });
    cur.active = null;
    if (stepIndex === steps.length) {
      completedAt = at;
      return;
    }
    const step = steps[stepIndex];
    if (step.kind === "sleep") {
      cur.active = { kind: "sleep", until: at + step.units * UNIT };
      return;
    }
    const timed = step.units !== undefined;
    const stored = oldestSent();
    if (stored) {
      // awaitEvent consumes a send stored before the wait started. A timed
      // wait writes its timeout onto that record, which makes it an ended
      // timed wait for the "latest record" check in `send`.
      stored.state = "consumed";
      if (timed) stored.timed = true;
      results.push(
        timed ? { kind: "event", value: stored.value } : stored.value,
      );
      stepIndex++;
      startStep(at, cause);
      return;
    }
    const record: EventRecord = { timed, state: "waiting" };
    records.push(record);
    cur.active = {
      kind: "wait",
      record,
      deadline: timed ? at + step.units! * UNIT : undefined,
    };
  }

  // The `send` mutation in event.ts, by name.
  function send(index: number) {
    const { at, value } = sends[index];
    const waiting = records.find((r) => r.state === "waiting");
    if (waiting) {
      waiting.state = "consumed";
      results.push(waiting.timed ? { kind: "event", value } : value);
      stepIndex++;
      startStep(at, index);
      return;
    }
    const latest = records[records.length - 1];
    if (
      latest?.timed &&
      (latest.state === "consumed" || latest.state === "timedOut")
    ) {
      return; // Dropped: late send to a timed wait that ended.
    }
    records.push({ timed: false, state: "sent", value });
  }

  startStep(0, null);
  let next = 0;
  let flushes = 0;
  while (completedAt === null || next < sends.length) {
    const a = cur.active;
    const internalAt =
      a?.kind === "sleep" ? a.until : (a?.deadline ?? Infinity);
    const sendAt = next < sends.length ? sends[next].at : Infinity;
    if (internalAt === Infinity && sendAt === Infinity) {
      // Stuck in an untimed wait with no sends left: add one.
      const last = changes[changes.length - 1].at;
      sends.push({ at: last + UNIT / 2, value: `flush${flushes++}` });
      continue;
    }
    if (internalAt <= sendAt) {
      if (a!.kind === "sleep") {
        results.push(null);
      } else {
        a!.record.state = "timedOut";
        results.push({ kind: "timeout" });
      }
      stepIndex++;
      startStep(internalAt, null);
    } else {
      send(next++);
    }
  }

  const predictable = sends.every((s, i) =>
    changes.every((c) => c.cause === i || Math.abs(c.at - s.at) >= MARGIN),
  );
  return { results, sends, completedAt: completedAt!, predictable };
}

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("sleep" as const),
    units: fc.integer({ min: 1, max: 3 }),
  }),
  fc.record({
    kind: fc.constant("wait" as const),
    units: fc.integer({ min: 1, max: 3 }),
  }),
  fc.constant({ kind: "wait" as const }),
);

const sendTimesArb = fc.array(fc.integer({ min: 0, max: 8 * UNIT }), {
  maxLength: 6,
});

async function advanceTo(t: T, target: number) {
  while (Date.now() < target) {
    vi.advanceTimersByTime(Math.min(TICK, target - Date.now()));
    await t.finishInProgressScheduledFunctions();
  }
}

function status(t: T, workflowId: WorkflowId) {
  return t.run((ctx) => getStatus(ctx, components.workflow, workflowId));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test(
  "awaitEvent by name matches the model for random steps and sends",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 5 }),
        sendTimesArb,
        async (steps, times) => {
          const model = simulate(
            steps,
            times.map((at, i) => ({ at, value: `v${i}` })),
          );
          fc.pre(model.predictable);

          // Drop timers left by the previous run's convex-test instance.
          vi.clearAllTimers();
          const t = initConvexTest();
          const start = Date.now();
          const workflowId = await t.run((ctx) =>
            workflow.start(
              ctx,
              internal.timedEvents.runScript,
              {
                steps: steps.map((s) =>
                  s.kind === "sleep"
                    ? { kind: "sleep" as const, ms: s.units * UNIT }
                    : {
                        kind: "wait" as const,
                        timeout:
                          s.units === undefined ? undefined : s.units * UNIT,
                      },
                ),
              },
              { startAsync: true },
            ),
          );
          for (const send of model.sends) {
            await advanceTo(t, start + send.at);
            // A send by name never throws, even when it is dropped.
            await t.run((ctx) =>
              sendEvent(ctx, components.workflow, {
                workflowId,
                name: "answer",
                value: send.value,
              }),
            );
          }
          await advanceTo(t, start + model.completedAt + MARGIN);
          await t.finishAllScheduledFunctions(vi.runAllTimers);
          const done = await status(t, workflowId);
          expect(done).toEqual({ type: "completed", result: model.results });
        },
      ),
      { numRuns: NUM_RUNS, maxSkipsPerRun: 1000 },
    );
  },
  10 * 60_000,
);
