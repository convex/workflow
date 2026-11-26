import { v } from "convex/values";
import { createEvent, vWorkflowId } from "@convex-dev/workflow";
import { components, internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { workflow } from "./example";

// Waits for "answer" by name, giving up after `timeout` ms.
export const waitByName = workflow
  .define({ args: { timeout: v.number() } })
  .handler(async (step, args) => {
    return await step.awaitEvent({
      name: "answer",
      validator: v.string(),
      timeout: args.timeout,
    });
  });

// A timed wait, then a pause, then an untimed wait with the same name.
// Used to check that a late send to the first wait doesn't reach the second.
export const waitTwiceByName = workflow
  .define({ args: { timeout: v.number(), pause: v.number() } })
  .handler(async (step, args) => {
    const first = await step.awaitEvent({
      name: "answer",
      validator: v.string(),
      timeout: args.timeout,
    });
    await step.sleep(args.pause);
    const second = await step.awaitEvent({
      name: "answer",
      validator: v.string(),
    });
    return { first, second };
  });

// Creates an event, then waits on its ID with a timeout.
export const waitById = workflow
  .define({ args: { timeout: v.number() } })
  .handler(async (step, args) => {
    const id = await step.runMutation(internal.timedEvents.createAnswerEvent, {
      workflowId: step.workflowId,
    });
    return await step.awaitEvent({ id, timeout: args.timeout });
  });

// Old behavior: an untimed wait that starts after the event was sent.
export const untimedAfterPause = workflow
  .define({ args: { pause: v.number() } })
  .handler(async (step, args) => {
    await step.sleep(args.pause);
    return await step.awaitEvent({ name: "answer", validator: v.string() });
  });

export const createAnswerEvent = internalMutation({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args) => {
    return await createEvent(ctx, components.workflow, {
      name: "answer",
      workflowId: args.workflowId,
    });
  },
});

// Two timed waits with the same name, separated by a pause.
export const timedTwiceByName = workflow
  .define({ args: { timeout: v.number(), pause: v.number() } })
  .handler(async (step, args) => {
    const first = await step.awaitEvent({
      name: "answer",
      validator: v.string(),
      timeout: args.timeout,
    });
    await step.sleep(args.pause);
    const second = await step.awaitEvent({
      name: "answer",
      validator: v.string(),
      timeout: args.timeout,
    });
    return { first, second };
  });

// A pause, then a timed wait. Used to send the event before the wait starts.
export const timedAfterPause = workflow
  .define({ args: { timeout: v.number(), pause: v.number() } })
  .handler(async (step, args) => {
    await step.sleep(args.pause);
    return await step.awaitEvent({
      name: "answer",
      validator: v.string(),
      timeout: args.timeout,
    });
  });

// Runs a list of sleeps and waits for "answer", in order, and returns one
// result per step (null for a sleep). timedEvents.property.test.ts generates
// these lists and checks the results against a model of the event rules.
export const runScript = workflow
  .define({
    args: {
      steps: v.array(
        v.union(
          v.object({ kind: v.literal("sleep"), ms: v.number() }),
          v.object({
            kind: v.literal("wait"),
            timeout: v.optional(v.number()),
          }),
        ),
      ),
    },
  })
  .handler(async (step, args) => {
    const results: unknown[] = [];
    for (const s of args.steps) {
      if (s.kind === "sleep") {
        await step.sleep(s.ms);
        results.push(null);
      } else if (s.timeout === undefined) {
        results.push(
          await step.awaitEvent({ name: "answer", validator: v.string() }),
        );
      } else {
        results.push(
          await step.awaitEvent({
            name: "answer",
            validator: v.string(),
            timeout: s.timeout,
          }),
        );
      }
    }
    return results;
  });
