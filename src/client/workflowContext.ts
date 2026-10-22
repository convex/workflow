import type { RetryBehavior, RetryOption } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import { parse } from "convex-helpers/validators";
import type {
  ArgsAndOptions,
  FunctionArgs,
  FunctionReference,
  FunctionReference_future,
  FunctionReturnType,
  FunctionType,
  FunctionVisibility,
} from "convex/server";
import type { Validator } from "convex/values";
import type {
  ConsumedWorkflowStep,
  EventId,
  SchedulerOptions,
  WorkflowId,
} from "../types.js";
import { safeFunctionName } from "./safeFunctionName.js";
import type { ExecutorRequest, StepRequest } from "./step.js";
import type {
  RunResult,
  TransactionLimits,
  WorkflowReturnType,
} from "./types.js";

export type RunOptions = {
  /**
   * The name of the function. By default, if you pass in api.foo.bar.baz,
   * it will use "foo/bar:baz" as the name. If you pass in a function handle,
   * it will use the function handle directly.
   */
  name?: string;
  /**
   * If true, the journal will not validate that the arguments match on replay.
   * This is useful when arguments are non-deterministic (e.g. derived from
   * a stack trace caught in the workflow) and you want to allow the workflow to
   * replay successfully despite argument changes.
   */
  unstableArgs?: boolean;
} & SchedulerOptions;

/**
 * Options applied to every step run through a `WorkflowCtx` derived with
 * {@link WorkflowCtx.withOptions}. Per-call options take precedence.
 */
export type StepDefaults = {
  /**
   * If true, the journal will not validate that step arguments match on
   * replay. See {@link RunOptions.unstableArgs}.
   */
  unstableArgs?: boolean;
  /**
   * Default retry behavior for action steps. Ignored for queries, mutations,
   * workflows, sleeps, and events. See workpool's {@link RetryOption}.
   */
  retry?: RetryBehavior | boolean;
};

type InlineArgs =
  | {
      inline: true;
      runAt?: never;
      runAfter?: never;
      /**
       * Per-transaction resource limits enforced on this inline step's
       * transaction. Exceeding a limit throws a catchable error in the
       * workflow handler.
       *
       * **Requires Convex >= 1.41.** Only supported for `inline` steps.
       */
      transactionLimits?: TransactionLimits;
    }
  | {
      inline?: false;
      /** @deprecated `transactionLimits` is only supported when `inline` is true. */
      transactionLimits?: TransactionLimits;
    };

export type WorkflowCtx = {
  /**
   * The ID of the workflow currently running.
   */
  workflowId: WorkflowId;
  /**
   * Run a query with the given name and arguments.
   *
   * @param query - The query to run, like `internal.index.exampleQuery`.
   * @param args - The arguments to the query function.
   * @param opts - Options for scheduling and naming the query.
   */
  runQuery<
    Query extends
      | FunctionReference<"query", FunctionVisibility>
      | FunctionReference_future<"query", FunctionVisibility>,
  >(
    query: Query,
    ...args: ArgsAndOptions<Query, RunOptions & InlineArgs>
  ): Promise<FunctionReturnType<Query>>;

  /**
   * Run a mutation with the given name and arguments.
   *
   * @param mutation - The mutation to run, like `internal.index.exampleMutation`.
   * @param args - The arguments to the mutation function.
   * @param opts - Options for scheduling and naming the mutation.
   */
  runMutation<
    Mutation extends
      | FunctionReference<"mutation", FunctionVisibility>
      | FunctionReference_future<"mutation", FunctionVisibility>,
  >(
    mutation: Mutation,
    ...args: ArgsAndOptions<Mutation, RunOptions & InlineArgs>
  ): Promise<FunctionReturnType<Mutation>>;

  /**
   * Run an action with the given name and arguments.
   *
   * @param action - The action to run, like `internal.index.exampleAction`.
   * @param args - The arguments to the action function.
   * @param opts - Options for retrying, scheduling and naming the action.
   */
  runAction<
    Action extends
      | FunctionReference<"action", FunctionVisibility>
      | FunctionReference_future<"action", FunctionVisibility>,
  >(
    action: Action,
    ...args: ArgsAndOptions<Action, RunOptions & RetryOption>
  ): Promise<FunctionReturnType<Action>>;

  /**
   * Run a workflow with the given name and arguments.
   *
   * @param workflow - The workflow to run, like `internal.index.exampleWorkflow`.
   * @param args - The arguments to the workflow function.
   * @param opts - Options for retrying, scheduling and naming the workflow.
   */
  runWorkflow<Workflow extends FunctionReference<"mutation", "internal">>(
    workflow: Workflow,
    args: FunctionArgs<Workflow>["args"],
    opts?: RunOptions,
  ): Promise<WorkflowReturnType<Workflow>>;

  /**
   * Blocks until a matching event is sent to this workflow.
   *
   * If an ID is specified, an event with that ID must already exist and must
   * not already be "awaited" or "consumed".
   *
   * If a name is specified, the first available event is consumed that matches
   * the name. If there is no available event, it will create one with that name
   * with status "awaited".
   * @param event
   */
  awaitEvent<T = unknown, Name extends string = string>(
    event: (
      | { name: Name; id?: EventId<Name> }
      | { name?: Name; id: EventId<Name> }
    ) & {
      validator?: Validator<T, any, any>;
    },
  ): Promise<T>;

  /**
   * Suspend execution for the given duration.
   *
   * @param duration - The number of milliseconds to sleep.
   * @param opts - Optionally name the step. Default: "sleep"
   */
  sleep(duration: number, opts?: { name?: string }): Promise<void>;

  /**
   * Introspection of (and remediation against) the workflow's journal — the
   * recorded log of steps this workflow has executed. All of these are
   * position-scoped: they answer relative to the current replay point, so
   * they return the same values on first execution and on every replay.
   */
  journal: {
    /**
     * The workflow definition's `version` as of this point in the journal.
     *
     * Behaves like `Date.now()`: while replaying, it returns the version
     * stamped on the next recorded step; at the frontier (no steps left to
     * replay), it returns the current definition's `version`. Steps recorded
     * before versions existed read as 0.
     *
     * Use it to gate behavior on which version of the code recorded the
     * history at this point:
     * ```ts
     * const step_ =
     *   step.journal.getVersion() < 2
     *     ? step.withOptions({ unstableArgs: true })
     *     : step;
     * ```
     * Gate *before* the steps it protects: code after the last recorded step
     * always sees the live version (same caveat as `Date.now()`).
     */
    getVersion: () => number;
    /**
     * The number of step calls made so far, including pending calls and
     * recorded steps successfully skipped with consumeNext(). This count
     * is the same at the same point on first execution and replay.
     */
    getStepCount: () => number;
    /**
     * Consume the next recorded journal entry without issuing a step call,
     * returning the entry (including its recorded `args` and required
     * `result`) for inspection. The result is a success, failure, or
     * cancellation. Nothing is re-executed and nothing new is recorded;
     * the entry stays in the journal for future replays.
     *
     * Use this when your code no longer issues a step that old histories
     * recorded — e.g. you removed a function call (or a library call whose
     * step name/args were computed internally) and want old workflows to
     * replay past it:
     * ```ts
     * if (step.journal.getVersion() < 2) {
     *   // v1 recorded a step here that v2 code no longer performs.
     *   const skipped = await step.journal.consumeNext("scrapePool/lib:enqueue");
     * }
     * ```
     *
     * @param name - If provided, throws unless the next recorded step has
     *   this name. Strongly recommended: without it, consuming the wrong
     *   step shifts every subsequent replay match by one.
     * @throws At the live frontier (no recorded steps left to replay) — only
     *   call this in a branch gated on replaying old history, e.g. via
     *   `getVersion()`. Do not call it inside `Promise.all`; it's
     *   positional, like the rest of replay matching.
     */
    consumeNext: (name?: string) => Promise<ConsumedWorkflowStep>;
  };

  /**
   * Derive a new `WorkflowCtx` that applies the given options to every step
   * it runs, unless overridden at the call site. The original ctx is
   * unaffected.
   *
   * This is especially useful when a library makes step calls on your behalf
   * (e.g. another component's client calling `ctx.runMutation` internally),
   * so you have no call site at which to pass options like `unstableArgs`:
   *
   * ```ts
   * // Workpool embeds its config (e.g. maxParallelism) in its enqueue args,
   * // so config changes would otherwise fail replays of in-flight workflows.
   * const lenient = step.withOptions({ unstableArgs: true });
   * await pool.enqueueAction(lenient, internal.scrape.page, { url });
   * ```
   *
   * Chaining is supported; later defaults override earlier ones.
   */
  withOptions(defaults: StepDefaults): WorkflowCtx;
};

export type JournalState = {
  version: number;
};

type RunStep = (request: Omit<StepRequest, "resolve">) => Promise<unknown>;

export function createWorkflowCtx(
  workflowId: WorkflowId,
  sender: BaseChannel<ExecutorRequest>,
  getJournalState?: () => JournalState,
  defaults?: StepDefaults,
  progress = { stepCount: 0 },
): WorkflowCtx {
  const journalState = () => {
    if (!getJournalState) {
      throw new Error("step.journal is not available in this context");
    }
    return getJournalState();
  };
  const runStep: RunStep = (request) => {
    // Count at the call site, before enqueueing can yield or block. Derived
    // contexts share this counter, independently of executor batching.
    progress.stepCount++;
    return run(sender, request);
  };
  return {
    workflowId,
    journal: {
      getVersion: () => journalState().version,
      getStepCount: () => {
        journalState();
        return progress.stepCount;
      },
      consumeNext: async (name?: string) => {
        let send: Promise<void>;
        const p = new Promise<ConsumedWorkflowStep>((resolve, reject) => {
          send = sender.push({
            consume: true,
            expectedName: name,
            resolve,
            reject,
          });
        });
        await send!;
        const entry = await p;
        progress.stepCount++;
        return entry;
      },
    },
    withOptions: (opts) =>
      createWorkflowCtx(
        workflowId,
        sender,
        getJournalState,
        { ...defaults, ...opts },
        progress,
      ),
    runQuery: async (query, args, opts?) => {
      return runFunction(runStep, "query", query, args, opts, defaults);
    },

    runMutation: async (mutation, args, opts?) => {
      return runFunction(runStep, "mutation", mutation, args, opts, defaults);
    },

    runAction: async (action, args, opts?) => {
      return runFunction(runStep, "action", action, args, opts, defaults);
    },

    runWorkflow: async (workflow, args, opts?) => {
      const { name, unstableArgs, ...schedulerOptions } = opts ?? {};
      return runStep({
        name: name ?? safeFunctionName(workflow),
        target: {
          kind: "workflow",
          function: workflow,
          args,
        },
        retry: undefined,
        inline: false,
        unstableArgs: unstableArgs ?? defaults?.unstableArgs ?? false,
        schedulerOptions,
        transactionLimits: undefined,
      }) as Promise<any>;
    },

    sleep: async (duration, opts?) => {
      await runStep({
        name: opts?.name ?? "sleep",
        target: {
          kind: "sleep",
          args: {},
        },
        retry: undefined,
        inline: false,
        unstableArgs: false,
        schedulerOptions: { runAfter: duration },
        transactionLimits: undefined,
      });
    },

    awaitEvent: async (event) => {
      const result = await runStep({
        name: event.name ?? event.id ?? "Event",
        target: {
          kind: "event",
          args: { eventId: event.id },
        },
        retry: undefined,
        inline: false,
        unstableArgs: false,
        schedulerOptions: {},
        transactionLimits: undefined,
      });
      if (event.validator) {
        return parse(event.validator, result);
      }
      return result as any;
    },
  } satisfies WorkflowCtx;
}

async function runFunction<
  F extends
    | FunctionReference<FunctionType, FunctionVisibility>
    | FunctionReference_future<FunctionType, FunctionVisibility>,
>(
  runStep: RunStep,
  functionType: FunctionType,
  f: F,
  args: Record<string, unknown> | undefined,
  opts?: RunOptions & {
    inline?: boolean;
    transactionLimits?: TransactionLimits;
  } & RetryOption,
  defaults?: StepDefaults,
): Promise<unknown> {
  const {
    name,
    retry,
    inline,
    transactionLimits,
    unstableArgs,
    ...schedulerOptions
  } = opts ?? {};
  if (
    inline &&
    schedulerOptions &&
    (schedulerOptions.runAt || schedulerOptions.runAfter)
  ) {
    throw new Error("Cannot combine `inline` with `runAt` or `runAfter`.");
  }
  if (inline && functionType === "action") {
    throw new Error("Cannot run an action inline.");
  }
  if (!inline && transactionLimits) {
    throw new Error("Cannot set transaction limits for non-inline functions.");
  }
  return runStep({
    name: name ?? safeFunctionName(f),
    target: {
      kind: "function",
      functionType,
      function: f,
      args: args ?? {},
    },
    retry: retry ?? (functionType === "action" ? defaults?.retry : undefined),
    inline: inline ?? false,
    unstableArgs: unstableArgs ?? defaults?.unstableArgs ?? false,
    transactionLimits,
    schedulerOptions,
  });
}

async function run(
  sender: BaseChannel<ExecutorRequest>,
  request: Omit<StepRequest, "resolve">,
): Promise<unknown> {
  let send: Promise<void>;
  const p = new Promise<RunResult>((resolve) => {
    send = sender.push({
      ...request,
      resolve,
    });
  });
  await send!;
  const result = await p;
  switch (result.kind) {
    case "success":
      return result.returnValue;
    case "failed":
      throw new Error(result.error);
    case "canceled":
      throw new Error("Canceled");
    default:
      throw new Error("Unknown result kind: " + (result as any).kind);
  }
}
