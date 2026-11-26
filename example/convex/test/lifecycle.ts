// Workflows for lifecycle.test.ts: restart after a failed run, cleanup, and
// the size limit on inline step results.

import { WorkflowManager } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "../_generated/api.js";
import { internalQuery } from "../_generated/server.js";

export const workflow = new WorkflowManager(components.workflow);

// The handler throws in the same run that starts the sleep, so the workflow
// fails while the sleep step is still running.
export const sleepBesideThrow = workflow
  .define({ args: {} })
  .handler(async (step): Promise<void> => {
    await Promise.all([
      step.sleep(5000),
      (async () => {
        throw new Error("handler threw");
      })(),
    ]);
  });

export const sleepOnce = workflow
  .define({ args: {} })
  .handler(async (step): Promise<void> => {
    await step.sleep(1000);
  });

export const bigString = internalQuery({
  args: { kb: v.number() },
  returns: v.string(),
  handler: async (_ctx, args) => "x".repeat(args.kb * 1024),
});

// Runs bigString inline and reports whether the step failed.
export const bigInline = workflow
  .define({ args: { kb: v.number() } })
  .handler(async (step, args): Promise<string> => {
    try {
      await step.runQuery(
        internal.test.lifecycle.bigString,
        { kb: args.kb },
        { inline: true },
      );
      return "ok";
    } catch {
      return "caught";
    }
  });
