import { describe, it, expect, test } from "vitest";
import { BaseChannel } from "async-channel";
import type { RunResult } from "./types.js";
import type { StepRequest } from "./step.js";
import { StepExecutor } from "./step.js";
import type { JournalEntry } from "../component/schema.js";
import { createWorkflowCtx } from "./workflowContext.js";
import type { WorkflowId } from "../types.js";
import { anyApi, type FunctionReference } from "convex/server";
import { initConvexTest } from "./setup.test.js";
import { ConvexError } from "convex/values";

// Fake function reference that satisfies the type constraints.
function fakeFuncRef(name: string) {
  return anyApi[name].default as FunctionReference<any, "internal">;
}

// Build a completed journal entry for replay.
function journalEntry(
  overrides: {
    name?: string;
    kind?: "function" | "workflow" | "event";
    args?: Record<string, unknown>;
    runResult?: RunResult;
    stepNumber?: number;
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
  receiver: BaseChannel<StepRequest>,
  entries: JournalEntry[],
) {
  for (const entry of entries) {
    const message = await receiver.get();
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
    const channel = new BaseChannel<StepRequest>(0);
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
    const channel = new BaseChannel<StepRequest>(0);
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
    expect(error).not.toBeInstanceOf(ConvexError);
    expect((error as Error).message).toBe("something broke");
  });

  it.each([
    null,
    false,
    0,
    "",
    "invalid input",
    { code: "INVALID", count: 7n },
    new Uint8Array([1, 2]).buffer,
  ])("restores ConvexError data from a journaled failure: %s", async (data) => {
    const channel = new BaseChannel<StepRequest>(0);
    const ctx = createWorkflowCtx("wf-error" as WorkflowId, channel);
    const entry = journalEntry({
      runResult: {
        kind: "failed",
        error: "error with server stack",
        errorData: data,
      },
    });
    const [error] = await Promise.all([
      ctx.runAction(fakeFuncRef("test"), {}).catch((error: unknown) => error),
      replayFromJournal(channel, [entry]),
    ]);
    expect(error).toBeInstanceOf(ConvexError);
    expect((error as ConvexError<typeof data>).data).toEqual(data);
    expect((error as Error).message).toBe(new ConvexError(data).message);
  });

  it("throws on a canceled step", async () => {
    const channel = new BaseChannel<StepRequest>(0);
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
    const channel = new BaseChannel<StepRequest>(0);
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
    const channel = new BaseChannel<StepRequest>(0);
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
    const channel = new BaseChannel<StepRequest>(0);
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
    const channel = new BaseChannel<StepRequest>(0);
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
    const channel = new BaseChannel<StepRequest>(0);
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
    const channel = new BaseChannel<StepRequest>(0);
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
    const channel = new BaseChannel<StepRequest>(0);
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
      new BaseChannel<StepRequest>(0),
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
    const channel = new BaseChannel<StepRequest>(0);
    const ctx = createWorkflowCtx("wf-test" as any, channel);

    const calls: StepRequest[] = [];
    const drain = async () => {
      for (let i = 0; i < 8; i++) {
        const msg = await channel.get();
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
    const channel = new BaseChannel<StepRequest>(0);
    const ctx = createWorkflowCtx("wf-test" as any, channel);
    const calls: StepRequest[] = [];
    const drain = async () => {
      for (let i = 0; i < count; i++) {
        const msg = await channel.get();
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
    const channel = new BaseChannel<StepRequest>(0);
    const ctx = createWorkflowCtx("wf-test" as any, channel);

    const calls: StepRequest[] = [];
    const drain = async () => {
      for (let i = 0; i < 3; i++) {
        const msg = await channel.get();
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
      new BaseChannel<StepRequest>(0),
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
    const channel = new BaseChannel<StepRequest>(0);
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
