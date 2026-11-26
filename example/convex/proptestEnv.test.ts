/// <reference types="vite/client" />

// Checks that Date.now() and Math.random() inside a workflow give the same
// values on every replay (see envDeterminism in proptest.ts).

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import fc from "fast-check";
import { getStatus } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { initConvexTest } from "./setup.test";
import { workflow } from "./example";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("Date.now and Math.random replay the same values", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 6 }),
      fc.integer({ min: 0, max: 5000 }),
      async (steps, sleepMs) => {
        vi.clearAllTimers();
        const t = initConvexTest();
        const workflowId = await t.run((ctx) =>
          workflow.start(ctx, internal.proptest.envDeterminism, {
            steps,
            sleepMs,
          }),
        );
        await t.finishAllScheduledFunctions(vi.runAllTimers);
        const status = await t.run((ctx) =>
          getStatus(ctx, components.workflow, workflowId),
        );
        expect(status.type).toBe("completed");
        const seen = (status as { result: { t: number; r: number }[] }).result;
        const rows = await t.run((ctx) =>
          ctx.db.query("proptestEffects").collect(),
        );
        expect(rows.map((r) => r.key).sort()).toEqual(
          seen.map((s, i) => `env${i}:${s.t}:${s.r}`).sort(),
        );
        // Time moves forward between steps that slept.
        for (let i = 1; i < seen.length; i++) {
          expect(seen[i].t).toBeGreaterThanOrEqual(seen[i - 1].t + sleepMs);
        }
      },
    ),
    { numRuns: Number(process.env.PROPTEST_RUNS ?? 50) },
  );
}, 600_000);
