import { describe, it, expect, test } from "vitest";
import { BaseChannel } from "async-channel";
import type { RunResult } from "./types.js";
import type { ExecutorRequest, StepRequest } from "./step.js";
import { StepExecutor } from "./step.js";
import type { JournalEntry } from "../component/schema.js";
import { createWorkflowCtx } from "./workflowContext.js";
import type { WorkflowId } from "../types.js";
import { anyApi, type FunctionReference } from "convex/server";
import { initConvexTest } from "./setup.test.js";

// Fake function reference that satisfies the type constraints.
function fakeFuncRef(name: string) {
  return anyApi[name].default as FunctionReference<any, "internal">;
}

// Narrow an ExecutorRequest to a StepRequest in tests that don't consume.
function asStepRequest(msg: ExecutorRequest): StepRequest {
  if ("consume" in msg) {
    throw new Error("Unexpected consume request");
  }
  return msg;
}

// Build a completed journal entry for replay.
function journalEntry(
  overrides: {
    name?: string;
    kind?: "function" | "workflow" | "event";
    args?: Record<string, unknown>;
    runResult?: RunResult;
    stepNumber?: number;
    version?: number;
  } = {},
): JournalEntry {
  const kind = overrides.kind ?? "function";
  const base = {
    _id: `step-${Math.random().toString(36).slice(2)}`,
    _creationTime: Date.now(),
    workflowId: "wf-test",
    stepNumber: overrides.stepNumber ?? 0,
  };
  const stepCommon = {
    name: overrides.name ?? "test",
    inProgress: false,
    argsSize: 10,
    args: overrides.args ?? {},
    runResult: overrides.runResult ?? {
      kind: "success" as const,
      returnValue: "ok",
    },
    startedAt: 1000,
    completedAt: 2000,
    version: overrides.version,
  };
  if (kind === "function") {
    return {
      ...base,
      step: {
        kind: "function",
        functionType: "action",
        handle: "handle",
        ...stepCommon,
      },
    } as unknown as JournalEntry;
  }
  if (kind === "event") {
    return {
      ...base,
      step: {
        kind: "event",
        ...stepCommon,
        args: overrides.args ?? { eventId: undefined },
      },
    } as JournalEntry;
  }
  return {
    ...base,
    step: {
      kind: "workflow",
      handle: "handle",
      ...stepCommon,
    },
  } as JournalEntry;
}

// Simulate the StepExecutor replay loop: read messages from the channel and
// resolve them from the journal, without needing a real Convex ctx.
async function replayFromJournal(
  receiver: BaseChannel<ExecutorRequest>,
  entries: JournalEntry[],
) {
  for (const entry of entries) {
    const message = await receiver.get();
    if ("consume" in message) {
      throw new Error("Unexpected consume request in replayFromJournal");
    }
    // Mirrors StepExecutor.completeMessage
    if (entry.step.runResult === undefined) {
      throw new Error(
        "Assertion failed: no outcome for completed function call",
      );
    }
    message.resolve(entry.step.runResult);
  }
}

describe("StepExecutor + WorkflowCtx integration", () => {
  it("resolves a successful step", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-1" as WorkflowId, channel);

    const entry = journalEntry({
      name: "test",
      runResult: { kind: "success", returnValue: 42 },
    });

    const [result] = await Promise.all([
      ctx.runAction(fakeFuncRef("test"), {}),
      replayFromJournal(channel, [entry]),
    ]);

    expect(result).toBe(42);
  });

  it("throws on a failed step and the error is catchable", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-2" as any, channel);

    const entry = journalEntry({
      name: "test",
      runResult: { kind: "failed", error: "something broke" },
    });

    const [error] = await Promise.all([
      ctx.runAction(fakeFuncRef("test"), {}).catch((e: Error) => e),
      replayFromJournal(channel, [entry]),
    ]);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("something broke");
  });

  it("throws on a canceled step", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-3" as any, channel);

    const entry = journalEntry({
      name: "test",
      runResult: { kind: "canceled" },
    });

    const [error] = await Promise.all([
      ctx.runAction(fakeFuncRef("test"), {}).catch((e: Error) => e),
      replayFromJournal(channel, [entry]),
    ]);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Canceled");
  });

  it("handles sequential steps", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-4" as any, channel);

    const entries = [
      journalEntry({
        name: "step1",
        args: { x: 1 },
        runResult: { kind: "success", returnValue: "first" },
        stepNumber: 0,
      }),
      journalEntry({
        name: "step2",
        args: { x: 2 },
        runResult: { kind: "success", returnValue: "second" },
        stepNumber: 1,
      }),
    ];

    const handler = async () => {
      const a = await ctx.runAction(fakeFuncRef("step1"), { x: 1 });
      const b = await ctx.runAction(fakeFuncRef("step2"), { x: 2 });
      return [a, b];
    };

    const [results] = await Promise.all([
      handler(),
      replayFromJournal(channel, entries),
    ]);

    expect(results).toEqual(["first", "second"]);
  });

  it("catches an error mid-workflow and continues", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-5" as any, channel);

    const entries = [
      journalEntry({
        name: "failing",
        runResult: { kind: "failed", error: "boom" },
        stepNumber: 0,
      }),
      journalEntry({
        name: "recovery",
        runResult: { kind: "success", returnValue: "recovered" },
        stepNumber: 1,
      }),
    ];

    const handler = async () => {
      let caught: string | undefined;
      try {
        await ctx.runAction(fakeFuncRef("failing"), {});
      } catch (e) {
        caught = (e as Error).message;
      }
      const result = await ctx.runAction(fakeFuncRef("recovery"), {});
      return { caught, result };
    };

    const [outcome] = await Promise.all([
      handler(),
      replayFromJournal(channel, entries),
    ]);

    expect(outcome.caught).toBe("boom");
    expect(outcome.result).toBe("recovered");
  });

  it("handles parallel steps via Promise.all", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-6" as any, channel);

    const entries = [
      journalEntry({
        name: "a",
        args: { v: "a" },
        runResult: { kind: "success", returnValue: 1 },
        stepNumber: 0,
      }),
      journalEntry({
        name: "b",
        args: { v: "b" },
        runResult: { kind: "success", returnValue: 2 },
        stepNumber: 1,
      }),
    ];

    const handler = async () => {
      return Promise.all([
        ctx.runAction(fakeFuncRef("a"), { v: "a" }),
        ctx.runAction(fakeFuncRef("b"), { v: "b" }),
      ]);
    };

    const [results] = await Promise.all([
      handler(),
      replayFromJournal(channel, entries),
    ]);

    expect(results).toEqual([1, 2]);
  });

  it("one failure in Promise.all rejects the batch", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-7" as any, channel);

    const entries = [
      journalEntry({
        name: "ok",
        args: { v: "ok" },
        runResult: { kind: "success", returnValue: "fine" },
        stepNumber: 0,
      }),
      journalEntry({
        name: "bad",
        args: { v: "bad" },
        runResult: { kind: "failed", error: "partial failure" },
        stepNumber: 1,
      }),
    ];

    const handler = async () => {
      return Promise.all([
        ctx.runAction(fakeFuncRef("ok"), { v: "ok" }),
        ctx.runAction(fakeFuncRef("bad"), { v: "bad" }),
      ]);
    };

    const [error] = await Promise.all([
      handler().catch((e: Error) => e),
      replayFromJournal(channel, entries),
    ]);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("partial failure");
  });

  it("error is thrown from run(), not from completeMessage", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-8" as any, channel);

    const entry = journalEntry({
      name: "test",
      runResult: { kind: "failed", error: "validation error" },
    });

    const [error] = await Promise.all([
      ctx.runAction(fakeFuncRef("test"), {}).catch((e: Error) => e),
      replayFromJournal(channel, [entry]),
    ]);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("validation error");
    // The error should originate from run() in workflowContext, not from
    // completeMessage in step.ts — this is the key change that gives users
    // their code in the stack trace.
    expect((error as Error).stack).toContain("workflowContext");
    expect((error as Error).stack).not.toContain("completeMessage");
  });

  it("runMutation works the same as runAction", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-9" as any, channel);

    const entry = journalEntry({
      name: "mut",
      runResult: { kind: "success", returnValue: "mutated" },
    });

    const [result] = await Promise.all([
      ctx.runMutation(fakeFuncRef("mut"), {}),
      replayFromJournal(channel, [entry]),
    ]);

    expect(result).toBe("mutated");
  });

  it("runQuery works the same as runAction", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-10" as any, channel);

    const entry = journalEntry({
      name: "qry",
      runResult: { kind: "success", returnValue: [1, 2, 3] },
    });

    const [result] = await Promise.all([
      ctx.runQuery(fakeFuncRef("qry"), {}),
      replayFromJournal(channel, [entry]),
    ]);

    expect(result).toEqual([1, 2, 3]);
  });
});

describe("unstableArgs", () => {
  function makeMessage(opts: {
    name: string;
    kind: "function" | "workflow";
    args: Record<string, unknown>;
    unstableArgs: boolean;
  }): StepRequest {
    return {
      name: opts.name,
      target:
        opts.kind === "function"
          ? {
              kind: "function",
              functionType: "action",
              function: fakeFuncRef(opts.name),
              args: opts.args,
            }
          : {
              kind: "workflow",
              function: fakeFuncRef(opts.name),
              args: opts.args,
            },
      retry: undefined,
      inline: false,
      unstableArgs: opts.unstableArgs,
      schedulerOptions: {},
      transactionLimits: undefined,
      resolve: () => {},
    };
  }

  function makeExecutor(entries: JournalEntry[]) {
    return new StepExecutor(
      "wf-test",
      0,
      {} as any,
      {} as any,
      entries,
      new BaseChannel<ExecutorRequest>(0),
      Date.now(),
      undefined,
    );
  }

  const kinds = ["function", "workflow"] as const;

  describe.each(kinds)("%s", (kind) => {
    test("mismatched args fails without unstableArgs", () => {
      const entry = journalEntry({
        name: "step",
        kind,
        args: { x: 1 },
      });
      const executor = makeExecutor([entry]);
      const message = makeMessage({
        name: "step",
        kind,
        args: { x: 2 },
        unstableArgs: false,
      });
      expect(() => executor.completeMessage(message, entry)).toThrow(
        "Journal entry mismatch",
      );
    });

    test("mismatched args succeeds with unstableArgs", () => {
      const entry = journalEntry({
        name: "step",
        kind,
        args: { x: 1 },
      });
      const executor = makeExecutor([entry]);
      const message = makeMessage({
        name: "step",
        kind,
        args: { x: 2 },
        unstableArgs: true,
      });
      expect(() => executor.completeMessage(message, entry)).not.toThrow();
    });

    test("matching args succeeds with unstableArgs", () => {
      const entry = journalEntry({
        name: "step",
        kind,
        args: { x: 1 },
      });
      const executor = makeExecutor([entry]);
      const message = makeMessage({
        name: "step",
        kind,
        args: { x: 1 },
        unstableArgs: true,
      });
      expect(() => executor.completeMessage(message, entry)).not.toThrow();
    });
  });

  test("still validates name even with unstableArgs", () => {
    const entry = journalEntry({ name: "original", args: { x: 1 } });
    const executor = makeExecutor([entry]);
    const message = makeMessage({
      name: "different",
      kind: "function",
      args: { x: 2 },
      unstableArgs: true,
    });
    expect(() => executor.completeMessage(message, entry)).toThrow(
      "Journal entry mismatch",
    );
  });

  test("unstableArgs passes through and defaults correctly", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-test" as any, channel);

    const calls: StepRequest[] = [];
    const drain = async () => {
      for (let i = 0; i < 8; i++) {
        const msg = asStepRequest(await channel.get());
        calls.push(msg);
        msg.resolve({ kind: "success", returnValue: null });
      }
    };

    await Promise.all([
      (async () => {
        // With unstableArgs: true
        await ctx.runQuery(fakeFuncRef("q"), {}, { unstableArgs: true });
        await ctx.runMutation(fakeFuncRef("m"), {}, { unstableArgs: true });
        await ctx.runAction(fakeFuncRef("a"), {}, { unstableArgs: true });
        await ctx.runWorkflow(fakeFuncRef("w"), {}, { unstableArgs: true });
        // Without unstableArgs (defaults to false)
        await ctx.runQuery(fakeFuncRef("q2"), {});
        await ctx.runMutation(fakeFuncRef("m2"), {});
        await ctx.runAction(fakeFuncRef("a2"), {});
        await ctx.runWorkflow(fakeFuncRef("w2"), {});
      })(),
      drain(),
    ]);

    expect(calls[0].unstableArgs).toBe(true);
    expect(calls[1].unstableArgs).toBe(true);
    expect(calls[2].unstableArgs).toBe(true);
    expect(calls[3].unstableArgs).toBe(true);
    expect(calls[4].unstableArgs).toBe(false);
    expect(calls[5].unstableArgs).toBe(false);
    expect(calls[6].unstableArgs).toBe(false);
    expect(calls[7].unstableArgs).toBe(false);
  });
});

describe("withOptions", () => {
  async function collectCalls(
    run: (ctx: ReturnType<typeof createWorkflowCtx>) => Promise<void>,
    count: number,
  ): Promise<StepRequest[]> {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-test" as any, channel);
    const calls: StepRequest[] = [];
    const drain = async () => {
      for (let i = 0; i < count; i++) {
        const msg = asStepRequest(await channel.get());
        calls.push(msg);
        msg.resolve({ kind: "success", returnValue: null });
      }
    };
    await Promise.all([run(ctx), drain()]);
    return calls;
  }

  test("applies unstableArgs to all step kinds", async () => {
    const calls = await collectCalls(async (ctx) => {
      const lenient = ctx.withOptions({ unstableArgs: true });
      await lenient.runQuery(fakeFuncRef("q"), {});
      await lenient.runMutation(fakeFuncRef("m"), {});
      await lenient.runAction(fakeFuncRef("a"), {});
      await lenient.runWorkflow(fakeFuncRef("w"), {});
    }, 4);
    expect(calls.map((c) => c.unstableArgs)).toEqual([true, true, true, true]);
  });

  test("per-call options override defaults", async () => {
    const calls = await collectCalls(async (ctx) => {
      const lenient = ctx.withOptions({ unstableArgs: true });
      await lenient.runMutation(fakeFuncRef("m"), {}, { unstableArgs: false });
      const strict = ctx.withOptions({ unstableArgs: false });
      await strict.runMutation(fakeFuncRef("m2"), {}, { unstableArgs: true });
    }, 2);
    expect(calls[0].unstableArgs).toBe(false);
    expect(calls[1].unstableArgs).toBe(true);
  });

  test("does not affect the original ctx", async () => {
    const calls = await collectCalls(async (ctx) => {
      ctx.withOptions({ unstableArgs: true });
      await ctx.runMutation(fakeFuncRef("m"), {});
    }, 1);
    expect(calls[0].unstableArgs).toBe(false);
  });

  test("chaining merges defaults, later wins", async () => {
    const retry = { maxAttempts: 3, initialBackoffMs: 10, base: 2 };
    const calls = await collectCalls(async (ctx) => {
      const derived = ctx
        .withOptions({ unstableArgs: true })
        .withOptions({ retry });
      await derived.runAction(fakeFuncRef("a"), {});
      const overridden = derived.withOptions({ unstableArgs: false });
      await overridden.runAction(fakeFuncRef("a2"), {});
    }, 2);
    expect(calls[0].unstableArgs).toBe(true);
    expect(calls[0].retry).toEqual(retry);
    expect(calls[1].unstableArgs).toBe(false);
    expect(calls[1].retry).toEqual(retry);
  });

  test("retry default only applies to actions", async () => {
    const calls = await collectCalls(async (ctx) => {
      const withRetry = ctx.withOptions({ retry: true });
      await withRetry.runAction(fakeFuncRef("a"), {});
      await withRetry.runMutation(fakeFuncRef("m"), {});
      await withRetry.runQuery(fakeFuncRef("q"), {});
      await withRetry.runWorkflow(fakeFuncRef("w"), {});
      // Per-call retry on an action still wins over the default.
      await withRetry.runAction(fakeFuncRef("a2"), {}, { retry: false });
    }, 5);
    expect(calls[0].retry).toBe(true);
    expect(calls[1].retry).toBeUndefined();
    expect(calls[2].retry).toBeUndefined();
    expect(calls[3].retry).toBeUndefined();
    expect(calls[4].retry).toBe(false);
  });
});

describe("transactionLimits", () => {
  const limits = { documentsRead: 5, bytesWritten: 100 };

  test("passes through inline runQuery/runMutation into the StepRequest", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-test" as any, channel);

    const calls: StepRequest[] = [];
    const drain = async () => {
      for (let i = 0; i < 3; i++) {
        const msg = asStepRequest(await channel.get());
        calls.push(msg);
        msg.resolve({ kind: "success", returnValue: null });
      }
    };

    await Promise.all([
      (async () => {
        await ctx.runQuery(
          fakeFuncRef("q"),
          {},
          { inline: true, transactionLimits: limits },
        );
        await ctx.runMutation(
          fakeFuncRef("m"),
          {},
          { inline: true, transactionLimits: limits },
        );
        // Inline without transactionLimits defaults to undefined.
        await ctx.runQuery(fakeFuncRef("q2"), {}, { inline: true });
      })(),
      drain(),
    ]);

    expect(calls[0].transactionLimits).toEqual(limits);
    expect(calls[1].transactionLimits).toEqual(limits);
    expect(calls[2].transactionLimits).toBeUndefined();
  });

  test("forwards transactionLimits to ctx.runQuery during inline execution", async () => {
    const recorded: Array<{ args: unknown; opts: unknown }> = [];
    const fakeCtx = {
      runQuery: (_fn: unknown, args: unknown, opts: unknown) => {
        recorded.push({ args, opts });
        return Promise.resolve(123);
      },
      // The journal persistence call (component.journal.startSteps) also goes
      // through runMutation; return an empty set of entries for it.
      runMutation: () => Promise.resolve([]),
    };
    const executor = new StepExecutor(
      "wf-test",
      0,
      fakeCtx as any,
      { journal: { startSteps: "handle" } } as any,
      [],
      new BaseChannel<ExecutorRequest>(0),
      Date.now(),
      undefined,
    );

    const message: StepRequest = {
      name: "q",
      target: {
        kind: "function",
        functionType: "query",
        function: fakeFuncRef("q"),
        args: { a: 1 },
      },
      retry: undefined,
      inline: true,
      unstableArgs: false,
      transactionLimits: limits,
      schedulerOptions: {},
      resolve: () => {},
    };

    // Inline execution calls `createFunctionHandle`, whose syscall is only
    // available inside a backend context, so run within convex-test's `t.run`.
    const t = initConvexTest();
    await t.run(() => executor.startSteps([message]));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].args).toEqual({ a: 1 });
    expect(recorded[0].opts).toEqual({ transactionLimits: limits });
  });

  test("rejects transactionLimits / inline where unsupported", async () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-test" as any, channel);

    // Actions cannot run inline.
    await expect(
      (ctx.runAction as any)(fakeFuncRef("a"), {}, { inline: true }),
    ).rejects.toThrow("Cannot run an action inline.");

    // transactionLimits is only valid for inline steps.
    await expect(
      (ctx.runMutation as any)(
        fakeFuncRef("m"),
        {},
        { transactionLimits: limits },
      ),
    ).rejects.toThrow(
      "Cannot set transaction limits for non-inline functions.",
    );

    // inline cannot be combined with scheduling.
    await expect(
      (ctx.runQuery as any)(
        fakeFuncRef("q"),
        {},
        { inline: true, runAfter: 1000 },
      ),
    ).rejects.toThrow("Cannot combine `inline` with `runAt` or `runAfter`.");
  });
});

describe("step.journal", () => {
  // Wire a real StepExecutor to a WorkflowCtx and run the executor loop in
  // the background, like workflowMutation does. The executor never reaches
  // startSteps in these tests (no frontier steps), so no real ctx is needed.
  function setup(
    entries: JournalEntry[],
    definedVersion?: number,
    capacity = 0,
  ) {
    const channel = new BaseChannel<ExecutorRequest>(capacity);
    const executor = new StepExecutor(
      "wf-test",
      0,
      {} as any,
      {} as any,
      entries,
      channel,
      12345,
      undefined,
      definedVersion,
    );
    const ctx = createWorkflowCtx(
      "wf-test" as any,
      channel,
      executor.getJournalState.bind(executor),
    );
    // Runs forever (until GC) once the journal is exhausted; don't await it.
    void executor.run();
    return { ctx, executor };
  }

  test.each([0, 1, 2, 10])(
    "getVersion follows recorded steps with channel capacity %s",
    async (capacity) => {
      const entries = [
        journalEntry({ name: "a", version: 1, stepNumber: 0 }),
        journalEntry({ name: "b", stepNumber: 1 }), // pre-version entry
      ];
      const { ctx } = setup(entries, 3, capacity);

      expect(ctx.journal.getVersion()).toBe(1);
      await ctx.runAction(fakeFuncRef("a"), {});
      // Next recorded step has no version stamp: reads as 0.
      expect(ctx.journal.getVersion()).toBe(0);
      await ctx.runAction(fakeFuncRef("b"), {});
      // Frontier: the current definition's version.
      expect(ctx.journal.getVersion()).toBe(3);
    },
  );

  test("getVersion defaults to 0 at the frontier with no defined version", async () => {
    const { ctx } = setup([]);
    expect(ctx.journal.getVersion()).toBe(0);
  });

  test("getStepCount advances with step calls", async () => {
    const entries = [
      journalEntry({ name: "a", stepNumber: 0 }),
      journalEntry({ name: "b", stepNumber: 1 }),
    ];
    const { ctx } = setup(entries, 1);

    expect(ctx.journal.getStepCount()).toBe(0);
    await ctx.runAction(fakeFuncRef("a"), {});
    expect(ctx.journal.getStepCount()).toBe(1);
    await ctx.runAction(fakeFuncRef("b"), {});
    expect(ctx.journal.getStepCount()).toBe(2);
  });

  test.each([0, 2, 10])(
    "counts all pending calls with channel capacity %s",
    async (capacity) => {
      const entries = Array.from({ length: 20 }, (_, stepNumber) =>
        journalEntry({ name: `step${stepNumber}`, stepNumber }),
      );
      const { ctx } = setup(entries, 1, capacity);
      const derived = ctx
        .withOptions({ unstableArgs: true })
        .withOptions({ retry: false });
      const pending = Array.from({ length: 20 }, (_, index) => {
        const caller = index % 2 ? derived : ctx;
        const result = caller.runAction(fakeFuncRef(`step${index}`), {});
        expect(ctx.journal.getStepCount()).toBe(index + 1);
        expect(derived.journal.getStepCount()).toBe(index + 1);
        return result;
      });
      await pending[0];
      expect(ctx.journal.getStepCount()).toBe(20);
      await Promise.all(pending);
      expect(ctx.journal.getStepCount()).toBe(20);
    },
  );

  test("step count is identical for parallel inline execution and replay", async () => {
    const recorded: JournalEntry[] = [];
    const fakeCtx = {
      runQuery: async () => "ok",
      runMutation: async (
        _fn: unknown,
        args: { steps: { step: JournalEntry["step"] }[] },
      ) => {
        const entries = args.steps.map(({ step }, index) => ({
          ...journalEntry({ stepNumber: index }),
          step,
        }));
        recorded.push(...entries);
        return entries;
      },
    };
    async function execute(entries: JournalEntry[]) {
      const channel = new BaseChannel<ExecutorRequest>(10);
      const executor = new StepExecutor(
        "wf-test",
        0,
        fakeCtx as any,
        { journal: { startSteps: "handle" } } as any,
        [...entries],
        channel,
        1000,
        undefined,
      );
      const ctx = createWorkflowCtx(
        "wf-test" as WorkflowId,
        channel,
        executor.getJournalState.bind(executor),
      );
      const handler = (async () => {
        const pending = Array.from({ length: 8 }, (_, index) =>
          ctx.runQuery(fakeFuncRef(`q${index}`), {}, { inline: true }),
        );
        const counts = [ctx.journal.getStepCount()];
        await pending[0];
        counts.push(ctx.journal.getStepCount());
        await Promise.all(pending);
        counts.push(ctx.journal.getStepCount());
        return counts;
      })();
      void executor.run();
      return handler;
    }
    const t = initConvexTest();
    const first = await t.run(() => execute([]));
    expect(recorded).toHaveLength(8);
    const replay = await execute(recorded);
    expect(first).toEqual([8, 8, 8]);
    expect(replay).toEqual(first);
  });

  test("invalid calls do not increment the step count", async () => {
    const { ctx } = setup([], 1);
    await expect(
      (ctx.runAction as any)(fakeFuncRef("a"), {}, { inline: true }),
    ).rejects.toThrow("Cannot run an action inline.");
    expect(ctx.journal.getStepCount()).toBe(0);
  });

  test("consumeNext consumes the next recorded step and returns it", async () => {
    const entries = [
      journalEntry({
        name: "legacy",
        args: { x: 1 },
        runResult: { kind: "success", returnValue: "old" },
        version: 1,
        stepNumber: 0,
      }),
      journalEntry({
        name: "kept",
        runResult: { kind: "success", returnValue: "still here" },
        version: 1,
        stepNumber: 1,
      }),
    ];
    const { ctx } = setup(entries, 2);

    const skipped = await ctx.journal.consumeNext("legacy");
    expect(skipped.name).toBe("legacy");
    expect(skipped.kind).toBe("function");
    expect(skipped.args).toEqual({ x: 1 });
    expect(skipped.result).toEqual({ kind: "success", returnValue: "old" });
    expect(skipped).not.toHaveProperty("runResult");
    expect(skipped.version).toBe(1);
    expect(skipped.stepNumber).toBe(0);

    // Consumption advanced the replay position: the next step call matches
    // the following entry, and the counters include the consumed entry.
    expect(ctx.journal.getStepCount()).toBe(1);
    const result = await ctx.runAction(fakeFuncRef("kept"), {});
    expect(result).toBe("still here");
  });

  test("consumeNext without a name consumes whatever is next", async () => {
    const entries = [journalEntry({ name: "whatever", stepNumber: 0 })];
    const { ctx } = setup(entries, 1);

    const skipped = await ctx.journal.consumeNext();
    expect(skipped.name).toBe("whatever");
  });

  test("consumeNext returns a recorded failure rather than throwing", async () => {
    const entries = [
      journalEntry({
        name: "failed",
        runResult: { kind: "failed", error: "boom" },
        stepNumber: 0,
      }),
    ];
    const { ctx } = setup(entries, 1);

    const skipped = await ctx.journal.consumeNext("failed");
    expect(skipped.result).toEqual({ kind: "failed", error: "boom" });
  });

  test("consumeNext returns a recorded cancellation rather than throwing", async () => {
    const entries = [
      journalEntry({ name: "canceled", runResult: { kind: "canceled" } }),
    ];
    const { ctx } = setup(entries, 1);

    const skipped = await ctx.journal.consumeNext("canceled");
    expect(skipped.result).toEqual({ kind: "canceled" });
  });

  test.each(["in-progress", "missing result"])(
    "consumeNext rejects a %s entry without consuming it",
    async (state) => {
      const entry = journalEntry({ name: "legacy" });
      entry.step.runResult = undefined;
      entry.step.inProgress = state === "in-progress";
      const { ctx } = setup([entry], 1);
      const error =
        state === "in-progress"
          ? "in-progress journal entry"
          : "no outcome for completed step";

      await expect(ctx.journal.consumeNext("legacy")).rejects.toThrow(error);
      expect(ctx.journal.getStepCount()).toBe(0);
      // Retrying still sees the same entry, rather than the live frontier.
      await expect(ctx.journal.consumeNext("legacy")).rejects.toThrow(error);
    },
  );

  test("consumeNext throws on a name mismatch", async () => {
    const entries = [journalEntry({ name: "other", stepNumber: 0 })];
    const { ctx } = setup(entries, 1);

    await expect(ctx.journal.consumeNext("legacy")).rejects.toThrow(
      'Journal entry mismatch: consumeNext (expected "legacy") found step "other"',
    );
  });

  test("a caught consumeNext mismatch leaves the journal aligned", async () => {
    const entries = [
      journalEntry({
        name: "other",
        runResult: { kind: "success", returnValue: "first" },
        stepNumber: 0,
      }),
      journalEntry({
        name: "kept",
        runResult: { kind: "success", returnValue: "second" },
        stepNumber: 1,
      }),
    ];
    const { ctx } = setup(entries, 1);

    await expect(ctx.journal.consumeNext("legacy")).rejects.toThrow(
      "Journal entry mismatch",
    );

    // The mismatched entry was not consumed, so replay continues from it
    // rather than being shifted by one.
    expect(ctx.journal.getStepCount()).toBe(0);
    expect(await ctx.runAction(fakeFuncRef("other"), {})).toBe("first");
    expect(await ctx.runAction(fakeFuncRef("kept"), {})).toBe("second");
  });

  test("consumeNext throws at the live frontier", async () => {
    const { ctx } = setup([], 1);

    await expect(ctx.journal.consumeNext("legacy")).rejects.toThrow(
      "no recorded step to consume",
    );
  });

  test("journal accessors throw without an executor (no getJournalState)", () => {
    const channel = new BaseChannel<ExecutorRequest>(0);
    const ctx = createWorkflowCtx("wf-test" as any, channel);
    expect(() => ctx.journal.getVersion()).toThrow(
      "step.journal is not available",
    );
  });

  test("withOptions-derived ctx shares the journal namespace", async () => {
    const entries = [journalEntry({ name: "a", version: 5, stepNumber: 0 })];
    const { ctx } = setup(entries, 7);
    const derived = ctx.withOptions({ unstableArgs: true });
    expect(derived.journal.getVersion()).toBe(5);
  });
});
