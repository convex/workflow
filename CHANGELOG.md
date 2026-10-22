# Changelog

## Unreleased

- Adds a `version: number` option to workflow definitions (default 0), stamped
  on the workflow and on each journal entry as steps first execute.
- Adds the `step.journal` namespace for replay-side introspection:
  - `getVersion()`: the definition version as of this point in the journal — the
    next recorded step's stamp while replaying, the current definition's
    `version` at the frontier (like `Date.now()` inside a workflow).
  - `getStepCount()`: step calls made so far, including pending calls and
    recorded steps skipped with `consumeNext()` (identical on first execution
    and on replay).
  - `consumeNext(name?)`: consume the next recorded journal entry without
    issuing a step call, returning the entry (recorded args and required
    `result`) for inspection. For replaying past steps that new code no longer
    performs; throws at the live frontier and on a name mismatch.
  
## 0.4.10

- Updates the /test entrypoint for compatibility with convex-test's new
  `defineTestApp` capability.

## 0.4.9

- Update types for convex 1.46 FunctionReference_future

## 0.4.8

- When paired with the latest Workpool (0.4.12), it will avoid registering an
  onComplete callback for the successful execution of workflow handlers,
  reducing unnecessary scheduled functions. (#283)

## 0.4.7

- Improves patching and restoration of globals to work better with convex-test.
  For best results, use convex-test >= 0.0.58

## 0.4.6

- Fixes the type of `step.runWorkflow(child, args)`: it now resolves to the
  child workflow's return value (per its `returns` validator) instead of the
  child's `WorkflowId`, which is what it has always resolved to at runtime. A
  workflow with no `returns` validator resolves to `unknown`. Code that relied
  on the old (incorrect) type will need updating.
- Workflow mutations now declare an argument validator, so statically generated
  API types describe their real shape instead of `any`. Malformed calls are
  rejected by argument validation rather than reaching the handler, so some
  errors are now Convex validator errors rather than workflow-specific ones.

## 0.4.5

- Adds `lenientCtx = step.withOptions({ unstableArgs: true })` to return a new
  WorkflowCtx that can be passed to libraries that have unstable arguments. All
  calls on the scoped `lenientCtx` will have the specified options applied to
  the relevant calls. This can also be used to provide a default retry policy
  for actions scheduled with the scoped WorkflowCtx.

## 0.4.4

- Adds support for `transactionLimits` (requires convex >= 1.41) when running
  inline queries / mutations.
- Updates the `ctx` type to be more permissive in usage, and compatible with
  updates to convex types up to 1.41.

## 0.4.3

- Update peer deps for workpool to leverage the recent optimizations by default

## 0.4.2

- Make `cleanup` resilient to workflows with many steps, events, and nested
  workflows by yielding to a scheduled continuation before transaction limits
  are hit (#255).
- Reduces the preview size to ~16k when a step / event is too big

## 0.4.1

- Support the alpha workpool

## 0.4.0

- Allows starting a workflow by calling it directly, like
  ```ts
  const workflowId = await ctx.runMutation(internal.my.workflow, {
    args: { ...workflowArgs },
    onComplete: await createFunctionHandle(internal.my.onComplete),
    context: { ...contextForOnComplete },
  });
  ```
  instead of using workflow.start.
- Enforce that `context` is passed when specifying `onComplete`.

## 0.3.12

- Steps that return values too large to store in the DB will now correctly throw
  a catchable error in the workflow.
- Export the WorkflowArgs type

## 0.3.11

- Adds support for `{ unstableArgs: true }` as an argument to various steps,
  e.g. `step.runQuery(internal.foo.bar, myArgs, { unstableArgs: true })` will
  not fail if `myArgs` changes between runs of the workflow handler. Use this
  carefully in scenarios where you are changing code in a backwards-compatible
  way, or if the args may change, e.g. passing a stack trace as an argument,
  since stack traces currently reflect the current stack trace.
- Validates v.id in workpool args are for the right table, now leveraging the
  shared `validate` implementation with convex-helpers.

## 0.3.10

- Allows defining workflow handlers separately from their args & return values,
  making it easier to break type cycles typically found in the handler function.

## 0.3.9

- Improved support for `convex-test` (testing via vitest). Testing workflows is
  mostly supported by `convex-test@0.0.45`. There are still edge cases around
  patched globals leaking into inline function calls, and other possibly
  undefined behavior.
- Fix registration of nested workpool component's naming.
- Cleans up patched globals at the end of the handler - useful for testing.

## 0.3.8

- Introduces an explicit `step.sleep(ms)` as an alternative to passing
  `runAfter` / `runAt` to a subsequent step.
- Improves test type of `register` for `convex-test@0.0.43`+ support

## 0.3.7

- Introduces { inline: true } for step.runQuery/runMutation, that skips using
  the Workpool in favor of calling them from the workflow's handler directly.
  This is more efficient, provided you're ok sharing the transaction limits with
  surrounding steps/ loading the workflow history. This means that workId is no
  longer guaranteed to be set for a function step
- Improve exception stack traces to include handler code.
- Updates the docs to use `step` instead of `ctx` (just a convention!)

## 0.3.6

- Allow restarting a workflow from a given step with `workflow.restart`
- Tightens the types to not allow passing `runAfter` and `runAt` at the same
  time

## 0.3.5

- Uses getConvexSize instead of bespoke sizing logic (requires convex ^1.31.7)
- Improves error messaging for journal entry mismatches
- Supports the latest Workpool (peer dep semver - no code changes needed)
- Fix: cleans up nested workflows and events

## 0.3.4

- Adds `list` and `listByName` APIs (credit: dantman) to list workflows with
  pagination options

## 0.3.3

- Export EventId type and vEventId validator from @convex-dev/workflow

## 0.3.2

- The WorkflowCtx (`ctx`) now matches the type of GenericActionCtx for basic
  functionality like `ctx.runMutation` / etc. so it's easier to use with things
  like components that only need that API. e.g. calling `resend.sendEmail(ctx,`
  with the Workflow's ctx.

## 0.3.1

- Bumps the workpool version dependency and automatically registers it in tests.

## 0.3.0

- Adds /test and /\_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API

## 0.2.8 alpha

- Adds asynchronous events - wait for an event in a workflow, send events
  asynchronously - allows pause/resume, human-in-loop, etc.
- Supports nested workflows with step.runWorkflow.
- Surfaces return value of the workflow in the status
- You can start a workflow directly from the CLI / dashboard without having to
  make a mutation to call workflow.start:
  - `{ fn: "path/to/file:workflowName", args: { ...your workflow args } }`
- Reduces read bandwidth when reading the journal after running many steps in
  parallel.
- Simplifies the onComplete type requirement so you can accept a workflowId as a
  string. This helps when you have statically generated types which can't do
  branded strings.
- Adds a /test entrypoint to make testing easier
- Exports the `WorkflowCtx` and `WorkflowStep` types
- Support for Math.random via seeded PRNG.

## 0.2.7

- Support for console logging & timing in workflows
- Support for Date.now() in workflows
- Batches the call to start steps
- Adds the workflow name to the workpool execution for observability
- Logs any error that shows up in the workflow body
- Will call onComplete for Workflows with startAsync that fail on their first
  invocation.
- Increases the max journal size from 1MB to 8MB
- Adds the WorkflowId type to step.workflowId
- Exposes /test entrypoint to make testing easier

## 0.2.6

- Allow calling components directly from steps
- Allow passing a function handle so you can run steps that call components
- Fixes an issue with conflicting Workpool versions

## 0.2.5

- Call the onComplete handler for canceled workflows
- Canceling is more graceful - canceled steps generally won't print errors
- Allow `startAsync` to enqueue the starting of the workflow to allow starting
  many workflows safely.
