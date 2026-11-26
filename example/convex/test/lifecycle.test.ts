/// <reference types="vite/client" />

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  getStatus,
  listSteps,
  restart,
  sendEvent,
} from "@convex-dev/workflow";
import { components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";
import { workflow } from "./lifecycle";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// The workflow fails while its sleep is still running, then is restarted.
// restart keeps the sleep's step row. When the sleep finished,
// onCompleteHandler in pool.ts dropped its result because it carried the old
// generation number, so the new generation's replay blocked on the step and
// the workflow stayed inProgress forever.
test.each([{ from: undefined }, { from: 1 }])(
  "restart (from $from) while a step from the failed run is still running",
  async ({ from }) => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.lifecycle.sleepBesideThrow, {}),
    );
    const failed = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(failed.type).toBe("failed");
    await t.run((ctx) =>
      restart(
        ctx,
        components.workflow,
        workflowId,
        from === undefined ? undefined : { from },
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    const steps = await t.run((ctx) =>
      listSteps(ctx, components.workflow, workflowId),
    );
    expect({
      status: status.type,
      steps: steps.page.map((s) => [s.name, s.completedAt !== undefined]),
    }).toEqual({ status: "failed", steps: [["sleep", true]] });
  },
);

// cleanup used to delete only events a step referred to, so an event sent
// to the workflow but never waited for was left behind.
test("cleanup deletes an event nobody waited for", async () => {
  const t = initConvexTest();
  const workflowId = await t.run((ctx) =>
    workflow.start(ctx, internal.test.lifecycle.sleepOnce, {}),
  );
  await t.run((ctx) =>
    sendEvent(ctx, components.workflow, { workflowId, name: "unused" }),
  );
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(
    await t.run((ctx) => cleanup(ctx, components.workflow, workflowId)),
  ).toBe(true);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const events = await (
    t as unknown as {
      runInComponent: (
        path: string,
        fn: (ctx: any) => Promise<unknown[]>,
      ) => Promise<unknown[]>;
    }
  ).runInComponent("workflow", (ctx) => ctx.db.query("events").collect());
  expect(events).toEqual([]);
});

// A queued step's result over 800 KiB fails the step (pool.ts onComplete).
// An inline step's result skipped that check: under 1 MiB it succeeded, and
// over 1 MiB journal.startSteps threw "Value is too large" for the whole run,
// which the workflow couldn't catch.
test.each([810, 1100])(
  "an oversized inline result (%i KiB) fails the step",
  async (kb) => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(
        ctx,
        internal.test.lifecycle.bigInline,
        { kb },
        { startAsync: true },
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.run((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status).toEqual({ type: "completed", result: "caught" });
  },
);
