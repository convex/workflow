import { v } from "convex/values";
import { workflow } from "./example";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

// Demonstrates the step.journal namespace: versioning workflow code so that
// in-flight workflows replay old behavior while new workflows use new code,
// plus the number of step calls made so far.
export const versionedWorkflow = workflow
  .define({
    args: {},
    // Bump this when making a change that breaks replay of in-flight
    // workflows, then gate the old behavior on step.journal.getVersion().
    version: 2,
    returns: v.object({
      value: v.string(),
      stepCount: v.number(),
    }),
  })
  .handler(async (step) => {
    console.log(
      `journal: version=${step.journal.getVersion()} ` +
        `steps=${step.journal.getStepCount()}`,
    );

    if (step.journal.getVersion() < 2) {
      // v1 histories recorded a step here that v2 code no longer performs.
      // Consume the recorded entry so the rest of the history replays; the
      // recorded args and result are returned for inspection. The step name
      // is optional; if provided, it must match or consumeNext throws.
      const skipped = await step.journal.consumeNext(
        "journalExample:legacyStep",
      );
      console.log(`skipped recorded step ${skipped.name}`, skipped.result);
    }

    const value: string = await step.runMutation(
      internal.journalExample.smallStep,
      { value: "hello" },
    );

    return {
      value,
      stepCount: step.journal.getStepCount(),
    };
  });

export const smallStep = internalMutation({
  args: { value: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    return `processed: ${args.value}`;
  },
});
