import type { FunctionReference, FunctionReturnType } from "convex/server";
import type { GenericId, Infer, Validator, Value } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import type { WorkflowId } from "../types.js";

export type WorkflowComponent = ComponentApi;

/**
 * The value a workflow handler resolves to, according to its `returns`
 * validator. Defaults to `unknown` if the workflow has no `returns` validator.
 */
export type InferFromOptionalValidator<ReturnsValidator> = [
  ReturnsValidator,
] extends [Validator<any, any, any>]
  ? Infer<ReturnsValidator>
  : unknown;

export type RunResult<Returns = unknown> =
  | { kind: "success"; returnValue: Returns }
  | { kind: "failed"; error: string; errorData?: Value }
  | { kind: "canceled" };

/**
 * The value returned by the workflow mutation.
 *
 * Direct calls return the workflow ID. Internal polls return `complete` when
 * the handler finishes, carrying its validated result for the workflow driver.
 */
export type WorkflowMutationResult<Returns = unknown> =
  WorkflowId | { kind: "complete"; runResult: RunResult<Returns> };

type ReturnValueFromWorkflowMutation<Result> = Result extends {
  kind: "complete";
  runResult: infer CompletionResult;
}
  ? CompletionResult extends {
      kind: "success";
      returnValue: infer Returns;
    }
    ? Returns
    : never
  : never;

/**
 * Recover a workflow's return type from its function reference.
 *
 * The internal poll's `complete` result carries the handler's validated return
 * value. Other branches of the mutation's return union are ignored.
 */
export type WorkflowReturnType<
  Workflow extends FunctionReference<"mutation", any, any>,
> = ReturnValueFromWorkflowMutation<FunctionReturnType<Workflow>>;

export type IdsToStrings<T> =
  T extends GenericId<string>
    ? string
    : T extends (infer U)[]
      ? IdsToStrings<U>[]
      : T extends Record<string, Value | undefined>
        ? { [K in keyof T]: IdsToStrings<T[K]> }
        : T;

/**
 * Per-transaction resource limits for an inline query or mutation.
 *
 * When passed to an inline `runQuery`/`runMutation` step, these caps are
 * enforced on that step's transaction; exceeding any of them throws an error
 * (which is catchable in the workflow handler, like any other step failure).
 *
 * **Requires Convex >= 1.41.** On older versions this option is ignored / not
 * supported by the running backend. Only applies to `inline` steps.
 */
export interface TransactionLimits {
  bytesRead?: number;
  bytesWritten?: number;
  databaseQueries?: number;
  documentsRead?: number;
  documentsWritten?: number;
  functionsScheduled?: number;
  scheduledFunctionArgsBytes?: number;
}
