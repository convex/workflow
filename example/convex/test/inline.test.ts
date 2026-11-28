/// <reference types="vite/client" />

import { getStatus, WorkflowManager } from "@convex-dev/workflow";
import { assert } from "convex-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { components, internal } from "../_generated/api";
import { initConvexTest } from "../setup.test";

const workflow = new WorkflowManager(components.workflow);

describe("inline queries and mutations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("sequential inline queries complete in one poll", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.sequentialInlineQueries, {
        key: "seq_test",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toEqual({ a: 0, b: 0 });
  });

  test("parallel inline queries resolve in push order", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.parallelInlineQueries, {
        key: "par_test",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    const result = status.result as {
      a: number;
      b: number;
      resolveOrder: string[];
    };
    // 'a' was pushed first, so it should resolve first in both
    // first-run (batched inline) and replay paths
    expect(result.resolveOrder).toEqual(["a", "b"]);
  });

  test("Promise.race picks first-pushed query", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.raceInlineQueries, {
        key: "race_test",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    // 'a' was pushed to channel first → completeMessage called first
    assert(status.type === "completed");
    expect((status.result as any).winner).toBe("a");
  });

  test("inline mutations execute and return sequentially", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.inlineMutations, {
        key: "mut_test",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    // Mutations run inline in sequence, incrementing a counter
    expect(status.result).toEqual({ first: 1, second: 2 });
  });

  test("mixed inline + action: query runs inline, action via workpool", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.mixedInlineAndAction, {
        key: "mixed_test",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    const result = status.result as {
      queryResult: number;
      actionResult: string;
    };
    expect(result.queryResult).toBe(0);
    expect(result.actionResult).toBe("action:mixed_test");
  });

  test("dependent inline queries: second uses result of first", async () => {
    const t = initConvexTest();
    const workflowId = await t.run((ctx) =>
      workflow.start(ctx, internal.test.inline.dependentInlineQueries, {
        key: "dep_test",
      }),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, workflowId),
    );
    expect(status.type).toBe("completed");
    assert(status.type === "completed");
    expect(status.result).toEqual({ first: 0, second: 0 });
  });
});

describe("inline callbacks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("custom mutation wrappers run triggers and replay skips their writes", async () => {
    const t = initConvexTest();
    const id = await t.mutation(internal.test.inline.callbackTriggers, {
      args: {},
    });
    assert(typeof id === "string");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, id),
    );
    expect(status).toEqual({ type: "completed", result: null });
    const rows = await t.query((ctx) =>
      ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", id))
        .take(10),
    );
    expect(rows.map((row) => row.in).sort()).toEqual(["audit", "trigger"]);
  });

  test("randomness inside parallel callbacks does not change replay", async () => {
    const t = initConvexTest();
    const id = await t.mutation(internal.test.inline.callbackRandomReplay, {
      args: {},
    });
    assert(typeof id === "string");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, id),
    );
    expect(status).toMatchObject({
      type: "completed",
      result: {
        value: expect.any(Number),
        first: expect.any(Number),
        later: expect.any(Number),
      },
    });
    assert(status.type === "completed");
    const result = status.result as { first: number; later: number };
    expect(result.first).not.toBe(result.later);
  });

  test("callback writes are not repeated after suspension", async () => {
    const t = initConvexTest();
    const id = await t.mutation(internal.test.inline.callbackWriteReplay, {
      args: {},
    });
    assert(typeof id === "string");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query((ctx) =>
      getStatus(ctx, components.workflow, id),
    );
    const rows = await t.query((ctx) =>
      ctx.db
        .query("flows")
        .withIndex("workflowId", (q) => q.eq("workflowId", id))
        .take(10),
    );
    expect(rows).toHaveLength(1);
    expect(status).toEqual({ type: "completed", result: rows[0]._id });
  });

  test.each([true, false])(
    "callback writes persist when catchError=%s",
    async (catchError) => {
      const t = initConvexTest();
      const id = await t.mutation(internal.test.inline.callbackPartialWrite, {
        args: { catchError },
      });
      assert(typeof id === "string");
      const status = await t.query((ctx) =>
        getStatus(ctx, components.workflow, id),
      );
      expect(status.type).toBe(catchError ? "completed" : "failed");
      const rows = await t.query((ctx) =>
        ctx.db
          .query("flows")
          .withIndex("workflowId", (q) => q.eq("workflowId", id))
          .take(10),
      );
      expect(rows).toHaveLength(1);
    },
  );
});
