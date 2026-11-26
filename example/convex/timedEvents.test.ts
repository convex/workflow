/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { assert } from "convex-helpers";
import {
  cancel,
  getStatus,
  listSteps,
  sendEvent,
  type EventId,
  type WorkflowId,
} from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { initConvexTest } from "./setup.test";
import { workflow } from "./example";

type T = ReturnType<typeof initConvexTest>;

// Advance fake time in small steps, running whatever comes due. Unlike
// finishAllScheduledFunctions, this does not jump ahead to the timeout.
async function advance(t: T, ms: number) {
  const tick = 50;
  for (let elapsed = 0; elapsed < ms; elapsed += tick) {
    vi.advanceTimersByTime(tick);
    await t.finishInProgressScheduledFunctions();
  }
}

async function status(t: T, workflowId: WorkflowId) {
  return t.run((ctx) => getStatus(ctx, components.workflow, workflowId));
}

function sendByName(t: T, workflowId: WorkflowId, value: string) {
  return t.run((ctx) =>
    sendEvent(ctx, components.workflow, { workflowId, name: "answer", value }),
  );
}

describe("awaitEvent with timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("event arrives before the timeout", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.waitByName,
        { timeout: 60_000 },
        { startAsync: true },
      ),
    );
    await advance(t, 1000);
    expect((await status(t, workflowId)).type).toBe("inProgress");

    await sendByName(t, workflowId, "hello");
    await advance(t, 1000);
    const done = await status(t, workflowId);
    assert(done.type === "completed");
    expect(done.result).toEqual({ kind: "event", value: "hello" });

    // The timeout firing later changes nothing, and a duplicate send is a
    // no-op rather than a throw or a stored event.
    await sendByName(t, workflowId, "again");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await status(t, workflowId);
    assert(after.type === "completed");
    expect(after.result).toEqual({ kind: "event", value: "hello" });
  });

  test("timeout fires first; a late send by name is dropped", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.waitTwiceByName,
        { timeout: 1000, pause: 10_000 },
        { startAsync: true },
      ),
    );
    // Past the timeout, into the pause before the second wait.
    await advance(t, 3000);
    const waiting = await status(t, workflowId);
    assert(waiting.type === "inProgress");
    expect(waiting.running.map((s) => s.kind)).toEqual(["sleep"]);

    // Late answer to the first wait: must not throw and must not be stored.
    await sendByName(t, workflowId, "late");

    // Let the pause end and the second (untimed) wait start.
    await advance(t, 10_000);
    const second = await status(t, workflowId);
    assert(second.type === "inProgress");
    expect(second.running.map((s) => s.kind)).toEqual(["event"]);

    await sendByName(t, workflowId, "fresh");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = await status(t, workflowId);
    assert(done.type === "completed");
    expect(done.result).toEqual({
      first: { kind: "timeout" },
      second: "fresh",
    });
  });

  test("a send before the timed wait starts is received immediately", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.timedAfterPause,
        { timeout: 60_000, pause: 1000 },
        { startAsync: true },
      ),
    );
    await advance(t, 200);
    // Sent during the pause, before the wait exists: stored as "sent".
    await sendByName(t, workflowId, "early");
    // Well short of the 60s timeout.
    await advance(t, 2000);
    const done = await status(t, workflowId);
    assert(done.type === "completed");
    expect(done.result).toEqual({ kind: "event", value: "early" });

    // A late duplicate send is dropped and doesn't throw.
    await sendByName(t, workflowId, "duplicate");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await status(t, workflowId);
    assert(after.type === "completed");
    expect(after.result).toEqual({ kind: "event", value: "early" });
  });

  test("a late send after a timeout does not satisfy the next timed wait", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.timedTwiceByName,
        { timeout: 1000, pause: 10_000 },
        { startAsync: true },
      ),
    );
    // First wait times out; the workflow is now in the pause.
    await advance(t, 3000);
    const pausing = await status(t, workflowId);
    assert(pausing.type === "inProgress");
    expect(pausing.running.map((s) => s.kind)).toEqual(["sleep"]);

    await sendByName(t, workflowId, "late");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = await status(t, workflowId);
    assert(done.type === "completed");
    expect(done.result).toEqual({
      first: { kind: "timeout" },
      second: { kind: "timeout" },
    });
  });

  test("a late send by ID does not throw", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.waitById,
        { timeout: 1000 },
        { startAsync: true },
      ),
    );
    await advance(t, 500);
    const waiting = await status(t, workflowId);
    assert(waiting.type === "inProgress");
    const step = waiting.running[0];
    assert(step.kind === "event" && step.eventId);
    const eventId = step.eventId as EventId;

    await advance(t, 2000);
    const done = await status(t, workflowId);
    assert(done.type === "completed");
    expect(done.result).toEqual({ kind: "timeout" });

    const sent = await t.run((ctx) =>
      sendEvent(ctx, components.workflow, { id: eventId, value: "late" }),
    );
    expect(sent).toBe(eventId);
    // A second late send is also a no-op.
    await t.run((ctx) =>
      sendEvent(ctx, components.workflow, { id: eventId, value: "later" }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await status(t, workflowId);
    assert(after.type === "completed");
    expect(after.result).toEqual({ kind: "timeout" });
  });

  test("send by ID in time completes the wait once", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.waitById,
        { timeout: 60_000 },
        { startAsync: true },
      ),
    );
    await advance(t, 3000);
    const waiting = await status(t, workflowId);
    assert(waiting.type === "inProgress");
    const step = waiting.running[0];
    assert(step.kind === "event" && step.eventId);
    const eventId = step.eventId as EventId;

    await t.run((ctx) =>
      sendEvent(ctx, components.workflow, { id: eventId, value: 7 }),
    );
    // Duplicate send does not throw.
    await t.run((ctx) =>
      sendEvent(ctx, components.workflow, { id: eventId, value: 8 }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = await status(t, workflowId);
    assert(done.type === "completed");
    expect(done.result).toEqual({ kind: "event", value: 7 });
  });

  test("an error sent to a timed wait fails the workflow", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.waitByName,
        { timeout: 60_000 },
        { startAsync: true },
      ),
    );
    await advance(t, 500);
    await t.run((ctx) =>
      sendEvent(ctx, components.workflow, {
        workflowId,
        name: "answer",
        error: "declined",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = await status(t, workflowId);
    assert(done.type === "failed");
    expect(done.error).toContain("declined");
  });

  // The workflow ends (here by cancel; also when a failing replay starts the
  // wait beside a failed Promise.all branch) while the timed wait is open.
  // When the timeout fires, timeoutWait must still mark the step done. It
  // used to return as soon as it saw the workflow had finished, leaving the
  // step in progress for good, and a later restart that kept it would block.
  test("a timed wait in a finished workflow still ends at its timeout", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.waitByName,
        { timeout: 5000 },
        { startAsync: true },
      ),
    );
    await advance(t, 500);
    await t.run((ctx) => cancel(ctx, components.workflow, workflowId));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const steps = await t.run((ctx) =>
      listSteps(ctx, components.workflow, workflowId, {
        paginationOpts: { cursor: null, numItems: 10 },
      }),
    );
    const wait = steps.page.find((s) => s.kind === "event");
    expect(wait?.completedAt).toBeDefined();
  });

  test("canceled while waiting: later send and timeout are no-ops", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.waitByName,
        { timeout: 5000 },
        { startAsync: true },
      ),
    );
    await advance(t, 500);
    expect((await status(t, workflowId)).type).toBe("inProgress");

    await t.run((ctx) => cancel(ctx, components.workflow, workflowId));
    await sendByName(t, workflowId, "too late");
    // Fire the timeout and anything else pending.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await status(t, workflowId)).type).toBe("canceled");
    // Another send after the timeout fired is still a no-op.
    await sendByName(t, workflowId, "later still");
    expect((await status(t, workflowId)).type).toBe("canceled");
  });
});

describe("awaitEvent without timeout (unchanged)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a send with nothing waiting is stored for the next wait", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.timedEvents.untimedAfterPause,
        { pause: 5000 },
        { startAsync: true },
      ),
    );
    await advance(t, 500);
    const eventId = await sendByName(t, workflowId, "early");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = await status(t, workflowId);
    assert(done.type === "completed");
    expect(done.result).toBe("early");

    // Sending the consumed event again by ID still throws.
    await expect(
      t.run((ctx) =>
        sendEvent(ctx, components.workflow, { id: eventId, value: "x" }),
      ),
    ).rejects.toThrow(/Event already consumed/);
  });
});
