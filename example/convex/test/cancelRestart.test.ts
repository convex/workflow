/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cancel, getStatus, listSteps, restart } from "@convex-dev/workflow";
import { components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";
import { workflow } from "./fanIn";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// Canceling bumps the workflow's generation number, so the canceled step's
// own completion is dropped by onCompleteHandler in pool.ts. Before
// completeHandler closed the step itself, it stayed in progress forever and
// restart() without `from` blocked on it: the workflow stayed inProgress.
test("restart after cancel doesn't hang on the canceled step", async () => {
  const t = initConvexTest();
  const id = await t.run((ctx) =>
    workflow.start(ctx, internal.test.fanIn.fanIn, { width: 1, fail: false }),
  );
  await t.run((ctx) => cancel(ctx, components.workflow, id));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const steps = await t.run((ctx) =>
    listSteps(ctx, components.workflow, id, {
      paginationOpts: { cursor: null, numItems: 10 },
    }),
  );
  expect(steps.page.map((s) => s.runResult?.kind)).toEqual(["canceled"]);

  await t.run((ctx) => restart(ctx, components.workflow, id));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  // Replaying the journal hits the canceled step, so the handler fails.
  const status = await t.run((ctx) => getStatus(ctx, components.workflow, id));
  expect(status.type).toBe("failed");
});
