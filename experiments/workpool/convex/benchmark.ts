import {
  Workpool,
  vResultValidator,
  vWorkIdValidator,
  type WorkId,
} from "@convex-dev/workpool";
import {
  Workpool as ExperimentalWorkpool,
  type TransactionalEnqueueOptions,
} from "@convex-dev/workpool-transactional";
import { WorkflowManager, type WorkflowId } from "../../../src/client/index.js";
import { type WorkflowComponent } from "../../../src/client/types.js";
import { v, type Infer } from "convex/values";
import { components, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";

const modeValidator = v.union(
  v.literal("baseline"),
  v.literal("prFiltered"),
  v.literal("filtered"),
  v.literal("transactional"),
  v.literal("allMutations"),
);
type Mode = Infer<typeof modeValidator>;
const workloadValidator = v.union(
  v.literal("pool"),
  v.literal("mutation"),
  v.literal("action"),
  v.literal("inline"),
);
const flowArgs = {
  run: v.string(),
  index: v.number(),
  steps: v.number(),
  workload: workloadValidator,
};
const contextValidator = v.object({ run: v.string(), index: v.number() });

function defineFlow(component: WorkflowComponent) {
  return new WorkflowManager(component, {
    workpoolOptions: { logLevel: "ERROR" },
  })
    .define({ args: flowArgs, returns: v.number() })
    .handler(async (step, args) => {
      let sum = 0;
      for (let i = 0; i < args.steps; i++) {
        const fnArgs = { run: args.run, index: args.index, step: i };
        sum +=
          args.workload === "action"
            ? await step.runAction(internal.benchmark.actionStep, fnArgs)
            : await step.runMutation(internal.benchmark.mutationStep, fnArgs, {
                inline: args.workload === "inline",
              });
      }
      return sum;
    });
}

export const baseline = defineFlow(components.baseline);
export const prFiltered = defineFlow(components.prFiltered);
export const filtered = defineFlow(components.filtered);
export const transactional = defineFlow(components.transactional);
export const allMutations = defineFlow(components.allMutations);

export const mutationStep = internalMutation({
  args: { run: v.string(), index: v.number(), step: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    await ctx.db.insert("writes", args);
    return args.step + 1;
  },
});

export const actionStep = internalAction({
  args: { run: v.string(), index: v.number(), step: v.number() },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> =>
    ctx.runMutation(internal.benchmark.mutationStep, args),
});

export const workflowDone = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: contextValidator,
  },
  returns: v.null(),
  handler: async (ctx, { result, context }) => {
    await ctx.db.insert("completions", {
      ...context,
      kind: result.kind,
      at: Date.now(),
      value: result.kind === "success" ? result.returnValue : undefined,
    });
    return null;
  },
});

export const poolWork = internalMutation({
  args: { run: v.string(), index: v.number(), fail: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, { run, index, fail }) => {
    await ctx.db.insert("completions", {
      run,
      index,
      kind: "executed",
      at: Date.now(),
    });
    if (fail) throw new Error("Intentional benchmark failure");
    return null;
  },
});

export const ignoredSuccess = internalMutation({
  args: {
    workId: vWorkIdValidator,
    result: vResultValidator,
    context: contextValidator,
  },
  returns: v.null(),
  handler: async (ctx, { result, context }) => {
    if (result.kind !== "success") {
      await ctx.db.insert("completions", {
        ...context,
        kind: result.kind,
        at: Date.now(),
      });
    }
    return null;
  },
});

function pool(mode: Mode, maxParallelism: number) {
  const options = { maxParallelism, logLevel: "ERROR" as const };
  return mode === "baseline" || mode === "filtered"
    ? new Workpool(components.poolBaseline, options)
    : new ExperimentalWorkpool(components.poolPr, options);
}

function completionOptions(
  mode: Mode,
): Omit<
  TransactionalEnqueueOptions<Infer<typeof contextValidator>, null>,
  "runAt" | "runAfter"
> {
  return {
    onComplete: internal.benchmark.ignoredSuccess,
    ...(mode !== "baseline"
      ? { onCompleteExcludeKinds: ["success"] as const }
      : {}),
    ...(mode === "transactional" || mode === "allMutations"
      ? { completeTransactionally: true }
      : {}),
  };
}

async function enqueuePoolWork(
  ctx: MutationCtx,
  p: ReturnType<typeof pool>,
  args: { run: string; index: number; fail?: boolean },
  options: TransactionalEnqueueOptions<Infer<typeof contextValidator>, null>,
): Promise<WorkId> {
  return p instanceof Workpool
    ? p.enqueueMutation(ctx, internal.benchmark.poolWork, args, options)
    : p.enqueueMutation(ctx, internal.benchmark.poolWork, args, options);
}

const trialArgs = {
  mode: modeValidator,
  workload: workloadValidator,
  count: v.number(),
  steps: v.number(),
  maxParallelism: v.number(),
  run: v.string(),
};

export const start = internalMutation({
  args: trialArgs,
  returns: v.object({ ids: v.array(v.string()), startedAt: v.number() }),
  handler: async (ctx, args) => {
    for (const [name, value, max] of [
      ["count", args.count, 1000],
      ["steps", args.steps, 20],
      ["maxParallelism", args.maxParallelism, 100],
    ] as const) {
      if (!Number.isInteger(value) || value < 1 || value > max)
        throw new Error(`Invalid ${name}`);
    }
    if (args.count * args.steps > 5000)
      throw new Error("At most 5000 step writes per trial");
    const ids: string[] = [];
    const startedAt = Date.now();
    if (args.workload === "pool") {
      const p = pool(args.mode, args.maxParallelism);
      const items = Array.from({ length: args.count }, (_, index) => ({
        run: args.run,
        index,
      }));
      const options = {
        ...completionOptions(args.mode),
        context: { run: args.run, index: -1 },
      };
      ids.push(
        ...(p instanceof Workpool
          ? await p.enqueueMutationBatch(
              ctx,
              internal.benchmark.poolWork,
              items,
              options,
            )
          : await p.enqueueMutationBatch(
              ctx,
              internal.benchmark.poolWork,
              items,
              options,
            )),
      );
    } else {
      const manager = new WorkflowManager(components[args.mode], {
        workpoolOptions: {
          maxParallelism: args.maxParallelism,
          logLevel: "ERROR",
        },
      });
      for (let index = 0; index < args.count; index++) {
        ids.push(
          await manager.start(
            ctx,
            internal.benchmark[args.mode],
            {
              run: args.run,
              index,
              steps: args.steps,
              workload: args.workload,
            },
            {
              startAsync: true,
              onComplete: internal.benchmark.workflowDone,
              context: { run: args.run, index },
            },
          ),
        );
      }
    }
    return { ids, startedAt };
  },
});

export const observe = internalQuery({
  args: { run: v.string() },
  returns: v.array(
    v.object({
      index: v.number(),
      kind: v.string(),
      value: v.optional(v.number()),
      at: v.number(),
    }),
  ),
  handler: async (ctx, { run }) =>
    (
      await ctx.db
        .query("completions")
        .withIndex("by_run", (q) => q.eq("run", run))
        .take(1001)
    ).map(({ index, kind, value, at }) => ({ index, kind, value, at })),
});

export const verify = internalQuery({
  args: { ...trialArgs, ids: v.array(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (args.workload === "pool") {
      return (
        await pool(args.mode, args.maxParallelism).statusBatch(
          ctx,
          args.ids as WorkId[],
        )
      ).every((s) => s.state === "finished");
    }
    const manager = new WorkflowManager(components[args.mode]);
    for (const id of args.ids) {
      const status = await manager.status(ctx, id as WorkflowId);
      if (
        status.type !== "completed" ||
        status.result !== (args.steps * (args.steps + 1)) / 2
      )
        throw new Error(`Invalid workflow: ${JSON.stringify(status)}`);
    }
    // This is a bounded benchmark audit, never part of the work's write path.
    const writes = await ctx.db
      .query("writes")
      .withIndex("by_run", (q) => q.eq("run", args.run))
      .take(5001);
    if (
      writes.length !== args.count * args.steps ||
      new Set(writes.map((w) => `${w.index}/${w.step}`)).size !== writes.length
    )
      throw new Error("Missing or duplicate step writes");
    return true;
  },
});

type Measurement = {
  elapsedMs: number;
  admissionMs: number;
  admittedAt: number;
  executionMs: number;
  p50Ms: number;
  p95Ms: number;
  throughput: number;
  count: number;
  steps: number;
};

export const run = internalAction({
  args: trialArgs,
  returns: v.object({
    elapsedMs: v.number(),
    admissionMs: v.number(),
    admittedAt: v.number(),
    executionMs: v.number(),
    p50Ms: v.number(),
    p95Ms: v.number(),
    throughput: v.number(),
    count: v.number(),
    steps: v.number(),
  }),
  handler: async (ctx, args): Promise<Measurement> => {
    const admissionStartedAt = Date.now();
    const { ids, startedAt } = await ctx.runMutation(
      internal.benchmark.start,
      args,
    );
    const admittedAt = Date.now();
    const deadline = admittedAt + 240_000;
    while (Date.now() < deadline) {
      const rows = await ctx.runQuery(internal.benchmark.observe, {
        run: args.run,
      });
      if (rows.length >= args.count) {
        const expectedKind = args.workload === "pool" ? "executed" : "success";
        if (
          rows.length !== args.count ||
          rows.some((r) => r.kind !== expectedKind) ||
          new Set(rows.map((r) => r.index)).size !== args.count
        )
          throw new Error("Invalid or duplicate completions");
        if (
          args.workload !== "pool" &&
          rows.some((r) => r.value !== (args.steps * (args.steps + 1)) / 2)
        )
          throw new Error("Incorrect workflow result");
        if (await ctx.runQuery(internal.benchmark.verify, { ...args, ids })) {
          const latencies = rows
            .map((r) => r.at - startedAt)
            .sort((a, b) => a - b);
          const elapsedMs = latencies[latencies.length - 1];
          const executionMs =
            rows.reduce((last, row) => Math.max(last, row.at), 0) - admittedAt;
          return {
            elapsedMs,
            admissionMs: admittedAt - admissionStartedAt,
            admittedAt,
            executionMs,
            p50Ms: latencies[Math.ceil(rows.length * 0.5) - 1],
            p95Ms: latencies[Math.ceil(rows.length * 0.95) - 1],
            throughput:
              (args.count *
                (args.workload === "pool" ? 1 : args.steps) *
                1000) /
              executionMs,
            count: args.count,
            steps: args.steps,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Benchmark timed out: ${args.run}`);
  },
});

// Exercise the non-success callbacks and rollback against the actual scheduler.
export const startFailureChecks = internalMutation({
  args: { mode: modeValidator, run: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { mode, run }): Promise<string[]> => {
    const p = pool(mode, 25);
    const failed = await enqueuePoolWork(
      ctx,
      p,
      { run, index: 0, fail: true },
      { ...completionOptions(mode), context: { run, index: 0 } },
    );
    const canceled = await enqueuePoolWork(
      ctx,
      p,
      { run, index: 1 },
      {
        ...completionOptions(mode),
        context: { run, index: 1 },
        runAfter: 60_000,
      },
    );
    await p.cancel(ctx, canceled);
    return [failed, canceled];
  },
});
