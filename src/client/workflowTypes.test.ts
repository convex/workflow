import type { FunctionReference, RegisteredMutation } from "convex/server";
import type {
  VFloat64,
  VNull,
  VObject,
  VString,
  Validator,
} from "convex/values";
import type { PropertyValidators } from "convex/values";
import { expectTypeOf, test } from "vitest";
import type { WorkflowId } from "../types.js";
import type { defineWorkflow, WorkflowManager } from "./index.js";
import type { WorkflowMutationResult } from "./types.js";
import type { WorkflowCtx } from "./workflowContext.js";

// Type-level regression tests: a workflow's `returns` validator has to survive
// the trip through the registered mutation's return type so that a parent
// workflow's `runWorkflow` resolves to the child's return value rather than to
// the WorkflowId returned by direct calls.

declare const _ctx: WorkflowCtx;

/**
 * A registered workflow reaches a parent workflow as a `FunctionReference` via
 * the generated `internal.*` api, so model that hop before asking what
 * `runWorkflow` returns.
 */
type AsRef<M> =
  M extends RegisteredMutation<"internal", infer Args, infer Returns>
    ? FunctionReference<"mutation", "internal", Args, Returns>
    : never;

type RunWorkflowResult<M> = Awaited<
  ReturnType<typeof _ctx.runWorkflow<AsRef<M>>>
>;

type Returns = Validator<any, "required", any> | void;

/** The mutation type produced by `defineWorkflow(...).handler(...)`. */
type Defined<AV extends PropertyValidators, RV extends Returns> = ReturnType<
  ReturnType<typeof defineWorkflow<AV, RV>>["handler"]
>;

/** The mutation type produced by `new WorkflowManager().define({...}).handler(...)`. */
type Managed<AV extends PropertyValidators, RV extends Returns> = ReturnType<
  Extract<
    ReturnType<typeof WorkflowManager.prototype.define<AV, RV>>,
    { handler: unknown }
  >["handler"]
>;

test("the mutation exposes its validated completion result", () => {
  expectTypeOf<Defined<{ foo: VString }, VFloat64>>().toExtend<
    RegisteredMutation<
      "internal",
      { args: { foo: string } },
      WorkflowMutationResult<number>
    >
  >();
});

test("defineWorkflow carries `returns` through to runWorkflow", () => {
  expectTypeOf<
    RunWorkflowResult<Defined<{ foo: VString }, VFloat64>>
  >().toEqualTypeOf<number>();
});

test("WorkflowManager.define carries `returns` through to runWorkflow", () => {
  expectTypeOf<
    RunWorkflowResult<
      Managed<{ foo: VString }, VObject<{ total: number }, { total: VFloat64 }>>
    >
  >().toEqualTypeOf<{ total: number }>();
});

test("a workflow without `returns` widens to unknown, not WorkflowId", () => {
  // There is no validator to read, so the nested result widens to `unknown` --
  // forcing a cast rather than silently handing back the WorkflowId the
  // mutation itself returns, or an unchecked `any`.
  expectTypeOf<
    RunWorkflowResult<Defined<{ foo: VString }, void>>
  >().toEqualTypeOf<unknown>();
});

test("a `v.null()` return does not leak undefined/void", () => {
  // `ReturnValueForOptionalValidator` would admit `void | null | undefined`
  // here, but a completed workflow always stores a concrete value.
  expectTypeOf<
    RunWorkflowResult<Defined<Record<string, never>, VNull>>
  >().toEqualTypeOf<null>();
});

type CodegenRef<R> = FunctionReference<
  "mutation",
  "internal",
  {
    args?: any;
    context?: any;
    docs?: string;
    fn?: string;
    generationNumber?: number;
    onComplete?: string;
    startAsync?: boolean;
    workflowId?: string;
  },
  | WorkflowId
  | {
      kind: "complete";
      runResult:
        | { kind: "success"; returnValue: R }
        | { kind: "failed"; error: string }
        | { kind: "canceled" };
    }
>;

test("the return type survives statically generated function types", () => {
  expectTypeOf<
    Awaited<ReturnType<typeof _ctx.runWorkflow<CodegenRef<number>>>>
  >().toEqualTypeOf<number>();
  expectTypeOf<
    Awaited<ReturnType<typeof _ctx.runWorkflow<CodegenRef<{ total: number }>>>>
  >().toEqualTypeOf<{ total: number }>();
  expectTypeOf<
    Awaited<ReturnType<typeof _ctx.runWorkflow<CodegenRef<null>>>>
  >().toEqualTypeOf<null>();
});

test("withOptions preserves the callback data model and normalized returns", () => {
  type DataModel = import("../component/_generated/dataModel.js").DataModel;
  type TypedStep = WorkflowCtx<DataModel>;
  expectTypeOf<
    ReturnType<TypedStep["withOptions"]>
  >().toEqualTypeOf<TypedStep>();
  const _run = null! as TypedStep["run"];
  expectTypeOf<Awaited<ReturnType<typeof _run<void>>>>().toEqualTypeOf<null>();
  expectTypeOf<
    Awaited<ReturnType<typeof _run<string | undefined>>>
  >().toEqualTypeOf<string | null>();
});
