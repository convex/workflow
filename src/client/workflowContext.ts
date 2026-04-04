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
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import { ConvexError, type Validator } from "convex/values";
import type { EventId, SchedulerOptions, WorkflowId } from "../types.js";
import { safeFunctionName } from "./safeFunctionName.js";
import type { StepRequest } from "./step.js";
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

export type WorkflowCtx<
  DataModel extends GenericDataModel = GenericDataModel,
> = {
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
     * Run a handler inline within the workflow's mutation transaction.
     * The result is journaled like any other step, so on replay it returns the
     * saved value without re-executing the handler.
     *
     * This gives direct access to the underlying mutation context, allowing
     * database reads/writes, running queries, and scheduling functions all
     * within the same transaction as the workflow handler.
     *
     * The handler can read from variables in the enclosing scope, but should
     * not modify them — on replay the handler is skipped and the journaled
     * result is returned, so any side effects outside the handler's return
     * value will not be replayed.
     *
     * To get a fully typed `ctx` with your data model, provide your app's
     * `internalMutation` in the workflow definition:
     *
     * ```ts
     * import { internalMutation } from "./_generated/server";
     * workflow.define({
     *   internalMutation,
     *   handler: async (ctx, args) => {
     *     const user = await ctx.run(async (ctx) => {
     *       return ctx.db.query("users").first(); // fully typed
     *     });
     *   },
     * });
     * ```
     *
     * @param handler - A function receiving the mutation context to run inline.
     * @param opts - Options for naming the step.
     */
    run<T>(
      handler: (ctx: GenericMutationCtx<DataModel>) => T | Promise<T>,
      opts?: { name?: string },
    ): Promise<T>;

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
      { name: Name; id?: EventId<Name> } | { name?: Name; id: EventId<Name> }
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

export function createWorkflowCtx<
  DataModel extends GenericDataModel = GenericDataModel,
>(
  workflowId: WorkflowId,
  sender: BaseChannel<StepRequest<DataModel>>,
  defaults?: StepDefaults,
): WorkflowCtx<DataModel> {
  let locked = false;
  const guardNotInlined = () => {
    if (locked) {
      throw new Error(
        "Cannot call step methods inside a step.run() handler. " +
          "Use the `ctx` argument passed to the handler instead, or " +
          "move this call outside of step.run().",
      );
    }
  };

  return {
    workflowId,
    withOptions: (opts) =>
      createWorkflowCtx(workflowId, sender, { ...defaults, ...opts }),
    runQuery: async (query, args, opts?) => {
      guardNotInlined();
      return runFunction(sender, "query", query, args, opts, defaults);
    },

    runMutation: async (mutation, args, opts?) => {
      guardNotInlined();
      return runFunction(sender, "mutation", mutation, args, opts, defaults);
    },

    runAction: async (action, args, opts?) => {
      guardNotInlined();
      return runFunction(sender, "action", action, args, opts, defaults);
    },

    run: async (handler, opts?) => {
      guardNotInlined();
      return run(sender, {
        name: opts?.name ?? "run",
        target: {
          kind: "inline",
          handler: async (ctx: GenericMutationCtx<DataModel>) => {
            locked = true;
            try {
              return await handler(ctx);
            } finally {
              locked = false;
            }
          },
          args: {} as Record<string, never>,
        },
        retry: undefined,
        inline: true,
        schedulerOptions: {},
        unstableArgs: false,
      }) as any;
    },

    runWorkflow: async (workflow, args, opts?) => {
      guardNotInlined();
      const { name, unstableArgs, ...schedulerOptions } = opts ?? {};
      return run(sender, {
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
      guardNotInlined();
      await run(sender, {
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
      guardNotInlined();
      const result = await run(sender, {
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
  };
}

async function runFunction<
  F extends
    | FunctionReference<FunctionType, FunctionVisibility>
    | FunctionReference_future<FunctionType, FunctionVisibility>,
  DM extends GenericDataModel,
>(
  sender: BaseChannel<StepRequest<DM>>,
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
  return run(sender, {
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

async function run<DM extends GenericDataModel>(
  sender: BaseChannel<StepRequest<DM>>,
  request: Omit<StepRequest<DM>, "resolve">,
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
      if (result.errorData !== undefined) {
        throw new ConvexError(result.errorData);
      }
      throw new Error(result.error);
    case "canceled":
      throw new Error("Canceled");
    default:
      throw new Error("Unknown result kind: " + (result as any).kind);
  }
}
