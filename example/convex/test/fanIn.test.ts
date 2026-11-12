/// <reference types="vite/client" />

import { getStatus } from "@convex-dev/workflow";
import { makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { handlerOnComplete } from "../../../src/component/pool.js";
import { components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";
import { handlerRuns, workflow } from "./fanIn";

type WithHandler<T> = T & { _handler: (...args: unknown[]) => unknown };

describe("fan-in of parallel steps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlerRuns.count = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test.each([{ fail: true }, { fail: false }])(
    "replays the handler once when all steps finish (fail: $fail)",
    async ({ fail }) => {
      const t = initConvexTest();
      // Called once per handler work item that the workpool records as failed.
      const failureCallback = vi.spyOn(
        handlerOnComplete as WithHandler<typeof handlerOnComplete>,
        "_handler",
      );
      const workflowId = await t.run((ctx) =>
        workflow.start(ctx, internal.test.fanIn.fanIn, { width: 8, fail }),
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const status = await t.run((ctx) =>
        getStatus(ctx, components.workflow, workflowId),
      );
      if (fail) {
        expect(status).toMatchObject({
          type: "failed",
          error: expect.stringContaining("boom"),
        });
      } else {
        expect(status).toEqual({ type: "completed", result: 8 });
      }
      // One run to start the steps and one replay once they have all finished.
      // The other queued runs return without replaying.
      expect(handlerRuns.count).toBe(2);
      expect(failureCallback).not.toHaveBeenCalled();
    },
  );

  test.each([{ fail: true }, { fail: false }])(
    "a duplicate run of a finished workflow does not replay (fail: $fail)",
    async ({ fail }) => {
      const t = initConvexTest();
      const workflowId = await t.run((ctx) =>
        workflow.start(ctx, internal.test.fanIn.fanIn, { width: 3, fail }),
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const before = await t.run((ctx) =>
        getStatus(ctx, components.workflow, workflowId),
      );
      const runsBefore = handlerRuns.count;

      // What a second handler work item for the same generation would do.
      const result = await t.mutation(
        makeFunctionReference<
          "mutation",
          { workflowId: string; generationNumber: number }
        >("test/fanIn:fanIn"),
        { workflowId, generationNumber: 0 },
      );

      expect(result).toBe(workflowId);
      expect(handlerRuns.count).toBe(runsBefore);
      const after = await t.run((ctx) =>
        getStatus(ctx, components.workflow, workflowId),
      );
      expect(after).toEqual(before);
    },
  );
});
