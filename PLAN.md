# Increment workflow generation on each execution

## Context

Currently, `generationNumber` on the workflow document starts at 0 and is **only incremented when a workflow is canceled** (`workflow.ts:271`). Its purpose is to invalidate in-flight step completions so they don't interfere with a canceled workflow.

The problem: since the generation never changes during normal execution, multiple concurrent executions of the same workflow handler can't be distinguished. When a workflow is canceled and its `onComplete` handler fires, in-flight step completions from the old execution can still race because the generation relationship between executions is loose. The generation should be incremented each time the workflow starts a new batch of steps, so that each "poll" of the workflow gets its own generation number.

## Changes

### 1. `src/component/journal.ts` — `startSteps` mutation

After validating the generation matches, increment `workflow.generationNumber` and write it to the DB. Use the **new** generation in step `OnCompleteContext` objects. Change the return type from `v.array(journalDocument)` to `v.object({ entries: v.array(journalDocument), generationNumber: v.number() })`.

Specifically:
- After `getWorkflow(ctx, args.workflowId, generationNumber)` succeeds (line 98), increment `workflow.generationNumber += 1` and `await ctx.db.replace(workflow._id, workflow)`
- Use `workflow.generationNumber` (the bumped value) instead of `args.generationNumber` in the `OnCompleteContext` for both nested workflows (line 154) and function steps (line 162)
- Wrap the return in `{ entries, generationNumber: workflow.generationNumber }`

### 2. `src/client/step.ts` — `StepExecutor` class

- In `startSteps()` (line 156): parse the new return shape from `component.journal.startSteps`. Update `this.generationNumber` with the returned value.
- Add a public `getGenerationNumber()` method that returns `this.generationNumber`.

### 3. `src/client/workflowMutation.ts`

- In the `"handlerDone"` case (line 173): use `executor.getGenerationNumber()` instead of the original `generationNumber` from args. This ensures `complete` is called with the bumped generation when steps were started, or the original generation when no steps were started (pure replay/completion).

### 4. No changes needed in `pool.ts`

- `onCompleteHandler`: already reads `generationNumber` from the step's context (which will now be the bumped value) and compares against the workflow's current generation. Works correctly.
- `enqueueWorkflow`: reads `generationNumber` from the workflow document (which is already bumped). Works correctly.
- `handlerOnComplete`: the workflow handler's workpool context uses the generation from when it was enqueued. If `startSteps` bumped the generation and then the handler was canceled, the stale context correctly mismatches. If no steps were started (handler failed early), the generation wasn't bumped so it still matches. Works correctly.

### 5. No changes needed in `workflow.ts`

- `completeHandler`: cancel logic still bumps the generation (now from the already-incremented value). This further invalidates any in-flight step completions. Works correctly.
- `createHandler`: still starts with generation 0. Works correctly.

## Execution flow (after changes)

1. Workflow created with gen 0
2. Handler enqueued with gen 0, validates gen 0 matches
3. `startSteps` validates gen 0, bumps to 1, starts steps with gen 1 in context
4. Step completes → `onCompleteHandler` sees gen 1 in context, matches workflow gen 1 → re-enqueues with gen 1
5. Handler runs with gen 1, `startSteps` bumps to 2, steps get gen 2
6. Late step completion from gen 1 → mismatch against workflow gen 2 → rejected

Cancel scenario:
1. Workflow at gen 1 (bumped by `startSteps`), steps have gen 1 context
2. Cancel bumps gen to 2, cancels steps
3. Step completions with gen 1 → mismatch → rejected
4. `onComplete` handler runs with clean state

## Backward compatibility

Existing deployed workflows with steps carrying gen 0 context will still work — the workflow document is also at gen 0 (never bumped), so `onCompleteHandler` matches. The first new execution after deployment will bump the generation, and from then on the new behavior kicks in.

## Verification

1. Run existing tests: `npm test` (or equivalent) — tests in `src/component/workflow.test.ts` and `example/convex/example.test.ts`
2. Verify the cancel test still passes (generation now starts at 0, cancel bumps it, same behavior)
3. Verify the create-async test still passes (workflow created at gen 0, handler enqueued with gen 0)
