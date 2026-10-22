# Convex Durable Workflows

[![npm version](https://badge.fury.io/js/@convex-dev%2Fworkflow.svg?)](https://badge.fury.io/js/@convex-dev%2Fworkflow)

<!-- START: Include on https://convex.dev/components -->

The Workflow component allows you to write **durable functions**: code that
orchestrates potentially-long-lived operations reliably, even in the face of
server restarts.

It can **pause** indefinitely while it waits for an asynchronous **event** or
**sleep** for an arbitrary amount of time, without consuming any resources in
the interim.

Step execution can be **determined dynamically** with branching, loops,
try/catch and more, all via regular code. Local variables, for-loops, console
logging, etc. work as you'd expect, even though under the hood the function will
be suspended and re-hydrated between steps.

Steps are regular Convex queries, mutations, or actions, and can run
**sequentially or in parallel** (e.g. `Promise.all`), using output from previous
steps or local variables. The overall workflow and each step has type-safe and
runtime-validated **arguments** and **return value**.

Workflows can be canceled and **restarted** from an arbitrary step, allowing you
to recover failed workflows after third party outages or fixing your code.

The **status** can be observed by many users simultaneously via regular
**reactive-by-default** Convex queries, and the history of each step's execution
is likewise live-updating.

**Retry behavior** for each action step is configurable, mutations have
**exactly-once** execution (ignoring rollbacks due to database conflicts, which
are automatically retried), and the overall workflow is guaranteed to run to
completion, with exactly-once execution of an `onComplete` handler.

Uses a Workpool under the hood to enable **parallelism limits** for steps, to
avoid spikes of asynchronous work consuming too many resources.

```ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";

export const workflow = new WorkflowManager(components.workflow);

export const userOnboarding = workflow
  .define({
    args: { userId: v.id("users") },
  })
  .handler(async (step, args): Promise<void> => {
    let result = await step.runAction(
      internal.llm.generateCustomContent,
      { userId: args.userId },
      // Retry this on transient errors with the default retry policy.
      { retry: true },
    );
    while (result.requiresRefinement) {
      // Run a whole workflow as a single step.
      result = await step.runWorkflow(internal.llm.refineContentWorkflow, {
        userId: args.userId,
        currentResult: result,
      });
    }
    const email = await step.runMutation(
      internal.emails.sendWelcomeEmail,
      { userId: args.userId, content: result.content },
      // Optimization: run the mutation synchronously from this transaction.
      { inline: true },
    );

    if (email.status === "needsVerification") {
      // Waits until verification is completed asynchronously.
      await step.awaitEvent({ name: "emailHasBeenVerified" });
    }

    // Wait 3 days before starting follow-ups.
    const DAY = 24 * 60 * 60 * 1000;
    await step.sleep(3 * DAY);

    for (let i = 0; i < 3; i++) {
      const sendTime = await getNextBestEmailTime(step, args.userId);
      const status = await step.runMutation(
        internal.emails.sendFollowUpEmailMaybe,
        { userId: args.userId },
        // Waits until this time to run this step.
        { runAt: sendTime },
      );
      if (!status.ok) break;
    }
  });
```

## How it works

The workflow tracks each `step` as it goes, executing steps asynchronously, and
resuming the workflow's handler where it left off when the step completes. If a
step fails, it will either retry based on the configured policy, or throw a
catch-able exception in the workflow handler, allowing graceful recovery.

While steps are executing, the workflow handler is not running. When it is time
to run the next step, it re-executes the code, deterministically replaying the
history until it finds the next step. The workflow itself is also run via the
Workpool, so exceptions thrown within the workflow will get delivered to the
`onComplete` handler.

## Installation

First, add `@convex-dev/workflow` to your Convex project:

```sh
npm install @convex-dev/workflow
```

Then, install the component within your `convex/convex.config.ts` file:

```ts
// convex/convex.config.ts
import workflow from "@convex-dev/workflow/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workflow);
export default app;
```

Finally, create a workflow manager within your `convex/` folder, and point it to
the installed component:

```ts
// convex/index.ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";

export const workflow = new WorkflowManager(components.workflow);
```

## Usage

The first step is to define a workflow using `workflow.define()`. This function
is designed to feel like a Convex action but with a few restrictions:

1. The workflow runs in the background, so the result can't be directly returned
   to whatever code starts it.
2. The workflow must be _deterministic_, so it should implement most of its
   logic by calling out to other Convex functions. We restrict access to some
   non-deterministic functions like `fetch`, env vars and `crypto`. Others we
   patch, such as `console` for logging, `Math.random()` (seeded PRNG) and
   `Date` for time.

Note: To help avoid type cycles, always annotate the return type of the
`handler` with the return type of the workflow.

```ts
export const exampleWorkflow = workflow
  .define({
    args: { exampleArg: v.string() },
    returns: v.string(),
  })
  .handler(async (step, args) => {
    const queryResult = await step.runQuery(
      internal.example.exampleQuery,
      args,
    );
    const actionResult = await step.runAction(
      internal.example.exampleAction,
      { queryResult }, // pass in results from previous steps!
    );
    return actionResult;
  });

export const exampleQuery = internalQuery({
  args: { exampleArg: v.string() },
  handler: async (ctx, args): Promise<string> => {
    return `The query says... Hi ${args.exampleArg}!`;
  },
});

export const exampleAction = internalAction({
  args: { queryResult: v.string() },
  handler: async (ctx, args): Promise<string> => {
    return args.queryResult + " The action says... Hi back!";
  },
});
```

### Starting a workflow

Once you've defined a workflow, you can start it from any mutation or action
using `start()`:

```ts
import { start } from "@convex-dev/workflow";
import { internal } from "./_generated/api";

export const kickoffWorkflow = mutation({
  handler: async (ctx): Promise<WorkflowId> => {
    // Starts the workflow immediately, run asynchronously
    const workflowId = await start(ctx, internal.example.exampleWorkflow, {
      exampleArg: "James",
    });
    return workflowId;
  },
});
```

You can also call workflows directly from code, the CLI or dashboard:

```sh
npx convex run example:exampleWorkflow '{ "args": { "exampleArg": "James" } }'
```

### Handling the workflow's result with onComplete

You can handle the workflow's result with `onComplete` by using the `start()`
helper. This is useful for cleaning up any resources used by the workflow.

Note: when you return things from a workflow, you'll need to specify the return
type of your `handler` to break type cycles due to using `internal.*` functions
in the body, which then inform the type of the workflow, which is included in
the `internal.*` type.

You can also specify a `returns` validator to do runtime validation on the
return value. If it fails, your `onComplete` handler will be called with an
error instead of success. You can also do validation in the `onComplete` handler
to have more control over handling that situation.

```ts
import { start, vWorkflowId } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";

export const foo = mutation({
  handler: async (ctx): Promise<WorkflowId> => {
    const name = "James";
    const workflowId = await start(
      ctx,
      internal.example.exampleWorkflow,
      { name },
      {
        onComplete: internal.example.handleOnComplete,
        context: { intent: "welcome", for: "James" }, // can be anything
      },
    );
    return workflowId;
  },
});

export const handleOnComplete = mutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    // used to pass through data from the start site.
    context: v.object({ intent: v.string(), for: v.string() }),
  },
  handler: async (ctx, args): Promise<void> => {
    const name = args.context.name;
    if (args.result.kind === "success") {
      const text = args.result.returnValue;
      console.log(`${name} result: ${text}`);
    } else if (args.result.kind === "error") {
      console.error("Workflow failed", args.result.error);
    } else if (args.result.kind === "canceled") {
      console.log("Workflow canceled", args.context);
    }
  },
});
```

### Running steps in parallel

You can run steps in parallel by calling `step.runAction()` multiple times in a
`Promise.all()` call.

```ts
export const exampleWorkflow = workflow
  .define({
    args: { name: v.string() },
  })
  .handler(async (step, args): Promise<void> => {
    const [result1, result2] = await Promise.all([
      step.runAction(internal.example.myAction, args),
      step.runAction(internal.example.myAction, args),
    ]);
  });
```

Note: The workflow will not proceed until all steps fired off at once have
completed. Note: if you are starting many tasks at once, it will only start the
first 10 (or maxParallelism) at once, to prevent one workflow from starving
others. It will start the next batch when all 10 have finished.

### Sleeping and running steps after a delay

Use `step.sleep` to pause a workflow for a given duration in milliseconds. The
workflow consumes no resources while sleeping.

```ts
// Wait one day before continuing
await step.sleep(24 * 60 * 60 * 1000);
```

Tip: You can name the sleep step for clarity with a second `{ name }` argument.

If you want to defer a specific step, you can use `runAfter` or `runAt` as
scheduling options on any step. This delays that particular step's execution:

```ts
// Run this action 10 seconds from now.
await step.runAction(internal.example.myAction, args, { runAfter: 10_000 });
```

This is roughly equivalent to doing a sleep first, with the difference being
that the "myAction" step is considered "in progress" while it is waiting, and it
only enqueues one item into the Workpool (myAction@delay), instead of two
(sleep@delay, myAction@now).

### Specifying retry behavior

Sometimes actions fail due to transient errors, whether it was an unreliable
third-party API or a server restart. You can have the workflow automatically
retry actions using best practices (exponential backoff & jitter). By default
there are no retries on actions, and if the exception isn't caught in the
workflow, it will call the onComplete as a failure. Note: all queries and
mutations (including the workflow handler) are retried automatically by Convex
on system errors, and no transaction will either partially commit or commit
twice (regular Convex guarantees).

You can specify default retry behavior for all workflows on the WorkflowManager,
or override it on a per-workflow basis.

You can also specify a custom retry behavior per-step, to opt-out of retries for
actions that may want at-most-once semantics.

Workpool options:

If you specify any of these, it will override the
[`DEFAULT_RETRY_BEHAVIOR`](./src/component/pool.ts).

- `defaultRetryBehavior`: The default retry behavior for all workflows.
  - `maxAttempts`: The maximum number of attempts to retry an action.
  - `initialBackoffMs`: The initial backoff time in milliseconds.
  - `base`: The base multiplier for the backoff. Default is 2.
- `retryActionsByDefault`: Whether to retry actions, by default is false.
  - If you specify a retry behavior at the step level, it will always retry.

At the step level, you can also specify `true` or `false` to use the default
policy or disable retries.

```ts
const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    defaultRetryBehavior: {
      maxAttempts: 3,
      initialBackoffMs: 100,
      base: 2,
    },
    retryActionsByDefault: true, // default is false
   }
});

export const exampleWorkflow = workflow
  .define({
    args: { name: v.string() },
    // If specified, this will override the workflow manager's default
    workpoolOptions: { ... },
  })
  .handler(async (step, args): Promise<void> => {
    // Uses default retry behavior & retryActionsByDefault
    await step.runAction(internal.example.myAction, args);
    // Retries will be attempted with the default behavior
    await step.runAction(internal.example.myAction, args, { retry: true });
    // No retries will be attempted
    await step.runAction(internal.example.myAction, args, { retry: false });
    // Custom retry behavior will be used
    await step.runAction(internal.example.myAction, args, {
      retry: { maxAttempts: 2, initialBackoffMs: 100, base: 2 },
    });
  });
```

### Specifying step parallelism

You can specify how many steps can run in parallel by setting the
`maxParallelism` workpool option. Note: this is not a limit of how many
workflows can be in progress. Any number of workflows can be in-flight. This
limit is how many queries/mutations/actions can be executing at the same time.

If you see that your scheduled functions are getting backlogged, you should
decrease this number. You can look for data on the Dashboard's Health and
Schedules pages, as well as in log stream data (tip: define alerts on this!).

If you don't specify a limit in code, you can set this dynamically without a
code push while your app is running. Run this from the CLI (or dashboard
function runner):

```sh
npx convex run --component workflow utils:updateConfig '{ maxParallelism: 50 }'
```

On a Pro account, avoid exceeding a total of 100 across all your workflows and
workpools. If you want to do a lot of work in parallel, you should employ
batching, where each workflow operates on a batch of work, e.g. scraping a list
of links instead of one link per workflow.

```ts
const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    // Note: You must only set this to one value per `components.<name>`!
    // You can set different values if you "use" multiple instances
    // with unique names in convex.config.ts.
    // Tip: use an environment variable for dynamic control
    maxParallelism: 10,
  },
});
```

### Running queries and mutations inline

By default, every `step.runQuery()` and `step.runMutation()` call is dispatched
through the workpool, which runs the function in an independent transaction. You
can opt in to running a query or mutation **inline**, sharing the workflow's
transaction by passing `{ inline: true }`:

```ts
export const myWorkflow = workflow
  .define({
    args: { userId: v.id("users") },
  })
  .handler(async (step, args): Promise<string> => {
    const user = await step.runQuery(
      internal.example.getUser,
      { userId: args.userId },
      { inline: true },
    );
    const updated = await step.runMutation(
      internal.example.updateUser,
      { userId: args.userId, name: user.name + "!" },
      { inline: true },
    );
    return updated;
  });
```

Because inline functions share the workflow's transaction, their reads and
writes count toward the same
[transaction limits](https://docs.convex.dev/production/state/limits#transactions).
If a step reads or writes a large amount of data, it's better to leave it
running through the work pool (the default) so it gets its own transaction
budget.

### Unstable step arguments and default step options

On replay, each step's arguments are validated against the journal, and a
mismatch fails the workflow with a determinism violation. If a step's arguments
are legitimately non-deterministic (e.g. derived from a caught stack trace) or
can change between deploys, you can opt that step out of argument validation
with `unstableArgs` (the step name and kind are still validated):

```ts
await step.runMutation(internal.example.recordError, { message }, {
  unstableArgs: true,
});
```

Sometimes a library makes the step call on your behalf, so there's no call
site at which to pass options. For example, another component's client may
call `ctx.runMutation` internally with its own config embedded in the
arguments, which would fail replays of in-flight workflows when that config
changes. For this, `step.withOptions(...)` derives a new step context that
applies default options to every step run through it:

```ts
const pool = new Workpool(components.scrapePool, { maxParallelism: 10 });

export const scrapeAll = workflow.define({
  args: { urls: v.array(v.string()) },
  handler: async (step, { urls }) => {
    // Workpool embeds its config in its enqueue arguments, so changing e.g.
    // maxParallelism would otherwise fail replays of in-flight workflows.
    const lenientStep = step.withOptions({ unstableArgs: true });
    for (const url of urls) {
      await pool.enqueueAction(lenientStep, internal.scrape.page, { url });
    }
  },
});
```

`withOptions` supports `unstableArgs` and a default `retry` behavior for
actions. Per-call options always take precedence, the original `step` context
is unaffected, and calls can be chained (later defaults win).

### Versioning workflow code with `step.journal`

Changing a workflow's code (reordering, adding, or removing steps) can break
replay for workflows that are already running. Use `step.journal` to keep those
workflows compatible with the new code:

```ts
export const scrapeAll = workflow.define({
  args: { urls: v.array(v.string()) },
  version: 2, // bump when making a breaking change; defaults to 0
  handler: async (step, { urls }) => {
    for (const url of urls) {
      // Skip argument validation for steps recorded before v2. Check each
      // iteration so new steps use normal validation.
      const lenientStep =
        step.journal.getVersion() < 2
          ? step.withOptions({ unstableArgs: true })
          : step;
      await pool.enqueueAction(lenientStep, internal.scrape.page, { url });
    }
  },
});
```

While replaying, `step.journal.getVersion()` returns the `version` used to
record the next step. Once all recorded steps have been replayed, it returns the
current workflow definition's `version`. Steps recorded without a version use 0.
Check the version _before_ the steps whose behavior changed.

If new code removes a step, use `step.journal.consumeNext()` to replay past it.
This also works for steps called by a library:

```ts
if (step.journal.getVersion() < 2) {
  // Skip the removed v1 step and inspect its recorded arguments and result.
  const skipped = await step.journal.consumeNext("scrapePool/lib:enqueue");
}
```

The step name is optional. If provided, `consumeNext` checks that it matches the
next recorded step and throws if it doesn't. Only call `consumeNext` when
replaying old steps, as in the version check above; it throws if there are no
recorded steps left to replay. The step is not rerun, and its history is
preserved for future replays. The returned step includes its recorded `args` and
a required `result`: a success, failure, or cancellation. Recorded failures are
returned in `result`, without throwing.

You can also check how many step calls the workflow has made so far:

```ts
step.journal.getStepCount();
```

The count includes pending calls and recorded steps skipped with
`consumeNext()`. It returns the same value at the same point on first execution
and replay, including when steps run in parallel.

### Checking a workflow's status

Calling a workflow returns a `WorkflowId` string, which can then be used for
querying a workflow's status.

```ts
import { vWorkflowId, getStatus, WorkflowStatus } from "@convex-dev/workflow";
import { components } from "./_generated/api";
import { query } from "./_generated/server";

export const runWorkflowAndPoll = query({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args): Promise<WorkflowStatus> => {
    await checkAuth(ctx, args);
    const status = await getStatus(ctx, components.workflow, args.workflowId);
    console.log("Workflow status", status);
    console.log("Running:", status.type === "inProgress" ? status.running : []);
    return status;
  },
});
```

Reading the status from a query will subscribe to the status, so your frontend
can reactively update as the workflow progresses.

### Canceling a workflow

You can cancel a workflow with `cancel()`, halting the workflow's execution
immediately. In-progress calls to `step.runAction()`, however, will finish
executing.

```ts
import { cancel } from "@convex-dev/workflow";

// ... Inside a mutation or action
await cancel(ctx, components.workflow, workflowId);
```

### Restart a failed workflow

If you want to re-run a workflow from a specific point, you can do so with
`restart(...)`. By default it will retry the handler using the existing history
of steps.

```ts
import { restart } from "@convex-dev/workflow";

// Re-executes the handler with the existing history of steps.
// This is useful if you had a bug in the handler code itself.
await restart(ctx, components.workflow, args.workflowId);
```

If a certain step failed, you can restart from that step onwards by providing
the step number, name, or function reference (`internal.foo.bar` e.g.). Events
are named after the event name or event ID if no name is given. You can get the
step number by listing the steps and using the `stepNumber`.

```ts
// Restart from a step number (0-indexed)
await restart(ctx, components.workflow, workflowId, { from: 2 });

// Restart from a step by name
await restart(ctx, components.workflow, workflowId, { from: "eventName" });

// Restart from a step by function reference
await restart(ctx, components.workflow, workflowId, {
  from: internal.example.myAction,
});
```

It will find the step by number, or the last step with the given name or
function reference and delete all subsequent steps, so the workflow will start
from that step when re-executing.

By default it will execute the handler in the same transaction so any errors
will be immediately visible. However, this means that on a handler error, the
restart itself will also be rolled back and the workflow will be unchanged.

If you want to retry the workflow in a separate transaction, you can do so by
passing `startAsync: true`. This will enqueue the handler via the workpool to
run asynchronously.

```ts
await restart(ctx, components.workflow, workflowId, { startAsync: true });
```

### Cleaning up a workflow

After a workflow has completed, you can clean up its storage with `cleanup()`.
Completed workflows are not automatically cleaned up by the system.

```ts
import { cleanup, vWorkflowId, vResultValidator } from "@convex-dev/workflow";

export const afterWorkflow = mutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.any(),
  },
  handler: async (ctx, args): Promise<void> => {
    // Clean up a completed workflow's storage.
    await cleanup(ctx, components.workflow, args.workflowId);
  },
});
```

You could alternatively use the `list` API to paginate through and clean up old
workflows from an hourly cron.

### Specifying a custom name for a step

You can specify a custom name for a step by passing a `name` option to the step.

This allows the events emitted to your logs to be more descriptive, as well as
restarting from a given step to be more clear. By default it uses the
`file/folder:function` name.

Note: The workflow will fail if the name of the function changes between when
the workflow is started and when it is resumed after some step (potentially much
later if it waited on an event or a `sleep`).

```ts
export const exampleWorkflow = workflow.define({
  args: { name: v.string() },
  handler: async (step, args): Promise<void> => {
    await step.runAction(internal.example.foo, args, { name: "some action" });
  },
});
```

Tip: If you want to rename or move a function that is for a given step, you can
use the name of the old function.

### Waiting for external events

Use `step.awaitEvent` inside a workflow handler to pause until an external event
is triggered. This is useful for human-in-the-loop flows or coordinating with
other asynchronous flows. Wait for an indefinite amount of time and continue
when the event is triggered.

At its simplest, you can wait for an event **by name**:

```ts
await step.awaitEvent({ name: "eventName" });
```

This will wait for the first un-consumed event with the name "eventName", and
will continue immediately if one was already sent. Events are sent by calling
`sendEvent` from a mutation or action:

```ts
import { sendEvent } from "@convex-dev/workflow";

await sendEvent(ctx, components.workflow, {
  name: "eventName",
  workflowId,
});
```

Note: You must send the event on the same workflow component that is waiting for
it, and the workflowId must match the ID of the workflow that is waiting for it.

#### Sending values or errors with the event

You can send a value with the event using the `value` property. For type safety
and runtime validation, provide a validator on the sending and receiving sides.

```ts
const sharedValidator = v.number();

// In the workflow:
const event = await step.awaitEvent({ name, validator: sharedValidator });

// From elsewhere:
await sendEvent(ctx, components.workflow, { name, workflowId, value: 42 });
```

To send an error, use the `error` property. This will cause `step.awaitEvent` to
throw an error.

```ts
await sendEvent(ctx, components.workflow, {
  name,
  workflowId,
  error: "An error occurred",
});
```

#### Sharing event definitions

Use `defineEvent` to define an event's name and validator in one place, then
share it between the workflow and the sender:

```ts
const approvalEvent = defineEvent({
  name: "approval",
  validator: v.object({ approved: v.boolean() }),
});

// In the workflow:
const approval = await step.awaitEvent(approvalEvent);

// From a mutation:
const value = { approved: true };
await sendEvent(ctx, components.workflow, {
  ...approvalEvent,
  workflowId,
  value,
});
```

See [`example/convex/userConfirmation.ts`](./example/convex/userConfirmation.ts)
for a full approval flow built this way.

Note: this is just a convenience to create a typed { event, validator } pair.

#### Waiting for dynamically created events by ID

You can also dynamically create an event with `createEvent`:

```ts
import { createEvent } from "@convex-dev/workflow";

const eventId = await createEvent(ctx, components.workflow, {
  name: "userResponse",
  workflowId,
});
```

Then wait for it by ID in the workflow:

```ts
await step.awaitEvent({ id: eventId });
```

This works well when there are dynamically defined events, for instance a tool
that is waiting for a response from a user. You would save the eventId somewhere
to be able to send the event later with `sendEvent`:

```ts
await sendEvent(ctx, components.workflow, { id: eventId });
```

Similar to named events, you can also send a value or error with the event.

See [`example/convex/passingSignals.ts`](./example/convex/passingSignals.ts) for
a complete example of creating events, passing their IDs around, and sending
signals.

### Running nested workflows with `step.runWorkflow`

Use `step.runWorkflow` to run another workflow as a single step in the current
one. The parent workflow waits for the nested workflow to finish and receives
its return value:
`const result = await step.runWorkflow(internal.example.childWorkflow, { args });`

You can also specify scheduling options like `{ runAfter: 5000 }` to delay the
nested workflow. See
[`example/convex/nestedWorkflow.ts`](./example/convex/nestedWorkflow.ts) for a
complete parent/child workflow example.

To associate the child workflow with the parent in your own tables, you can pass
the `step.workflowId` to the child workflow as an argument, and/or return the
child's workflowId to the parent.

The status of the parent workflow will include any active child workflowIds.

### Listing workflows and steps

Use `list` to get a paginated list of all workflows.

```ts
import { list, listByName, listSteps } from "@convex-dev/workflow";
```

```ts
await list(ctx, components.workflow, { order: "asc" });
```

Use `listByName` to get a paginated list of workflows matching a specific name.

```ts
await listByName(ctx, components.workflow, "file/folder:function", {
  order: "desc",
});
```

Both accept paginationOpts, such as `{ numItems: 50, cursor: null }` to get the
first 50 items, or with a continue cursor from a previous call to paginate
through them all.

Use `listSteps` with a workflow's ID to get a paginated list of the steps in
that workflow run.

```ts
await listSteps(ctx, components.workflow, workflowId);
```

## Tips and troubleshooting

### Circular dependencies

Having the return value of workflows depend on other Convex functions can lead
to circular dependencies due to the `internal.foo.bar` way of specifying
functions. The way to fix this is to explicitly type the return value of the
workflow. When in doubt, add return types to more `handler` functions, like
this:

```diff
 export const supportAgentWorkflow = workflow.define({
   args: { prompt: v.string(), userId: v.string(), threadId: v.string() },
+  handler: async (step, { prompt, userId, threadId }): Promise<string> => {
     // ...
   },
 });

 // And regular functions too:
 export const myFunction = action({
   args: { prompt: v.string() },
+  handler: async (ctx, { prompt }): Promise<string> => {
     // ...
   },
 });
```

### Tip: More concise workflows

To avoid the noise of `internal.foo.*` syntax, you can use a variable. For
instance, if you define all your steps in `convex/steps.ts`, you can do this:

```diff
 const s = internal.steps;

 export const myWorkflow = workflow.define({
   args: { prompt: v.string() },
   handler: async (step, args): Promise<string> => {
+    const result = await step.runAction(s.myAction, args);
     return result;
   },
 });
```

## Limitations

Here are a few limitations to keep in mind:

- Steps can only take in and return a total of _1 MB_ of data within a single
  workflow execution. If you run into journal size limits, you can work around
  this by storing results in the database or file storage from your step
  functions and passing IDs around within the the workflow.
- The workflow body is internally a mutation, with each step's return value read
  from the database on each subsequent step. As a result, the limits for a
  mutation apply and limit the number and size of steps you can perform
  (including the workflow state overhead). There is currently an 8MiB limit
  imposed on the journal size, to stay well within the mutation bounds. See more
  about mutation limits here:
  https://docs.convex.dev/production/state/limits#transactions
- If you need to use side effects like `fetch` or use crypto.subtle, you'll need
  to do that in a step, not in the workflow definition.
- `Math.random` in the handler itself is seeded per workflow for determinism and
  not suitable for cryptographic use. It is, however, useful for sharding,
  jitter, and other pseudo-random applications.
- If the implementation of the workflow meaningfully changes (steps added,
  removed, or reordered) then it will fail with a determinism violation. The
  implementation should stay stable for the lifetime of active workflows. See
  [this issue](https://github.com/convex/workflow/issues/35) for ideas on
  how to make this better.

Open a [GitHub issue](https://github.com/convex/workflow/issues) with any
feedback or bugs you find.

<!-- END: Include on https://convex.dev/components -->
