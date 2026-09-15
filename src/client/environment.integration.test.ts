import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { convexTest } from "convex-test";
import {
  anyApi,
  componentsGeneric,
  defineSchema,
  internalMutationGeneric,
  type FunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { getStatus, WorkflowManager, type WorkflowComponent } from "./index.js";
import workflowTest from "../test.js";

const component = componentsGeneric().workflow as unknown as WorkflowComponent;
const manager = new WorkflowManager(component);
const workflowRef = anyApi.environment.workflow as FunctionReference<
  "mutation",
  "internal",
  { fail: boolean },
  boolean
>;
const disabledKeys = [
  "process",
  "Crypto",
  "crypto",
  "CryptoKey",
  "SubtleCrypto",
];
const patchedKeys = ["Math", "Date", "Temporal", "console", ...disabledKeys];

const functions = {
  clockStep: internalMutationGeneric({
    args: { now: v.number() },
    returns: v.number(),
    handler: (_ctx, { now }) => now,
  }),
  workflow: manager
    .define({ args: { fail: v.boolean() }, returns: v.boolean() })
    .handler(async (step, { fail }) => {
      const global = globalThis as Record<string, unknown>;
      const disabled = disabledKeys.every((key) => global[key] === undefined);
      const temporal = global.Temporal as typeof Temporal;
      const now = temporal.Now.instant().epochMilliseconds;
      if (now !== Date.now()) throw new Error("Temporal and Date disagree");
      // The timestamp is part of the journaled args, so replay must reproduce it.
      const recordedTime = await step.runMutation(
        anyApi.environment.clockStep,
        {
          now,
        },
      );
      if (
        recordedTime !== now ||
        temporal.Now.instant().epochMilliseconds !== Date.now()
      ) {
        throw new Error("Temporal and Date disagree after a step");
      }
      if (fail) {
        throw new Error(`handler failed with globals disabled: ${disabled}`);
      }
      return disabled;
    }),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("Temporal", Temporal);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each([false, true])(
  "restores global values and descriptors after repeated workflows (throws: %s)",
  async (fail) => {
    // Use the real Workflow and Workpool components, including their scheduling.
    const t = convexTest(defineSchema({}), {
      "./_generated/api.ts": async () => ({}),
      "./environment.ts": async () => functions,
    });
    workflowTest.register(t);
    const global = globalThis as Record<string, unknown>;
    const originals = patchedKeys.map((key) => ({
      value: global[key],
      descriptor: Object.getOwnPropertyDescriptor(global, key),
    }));

    for (let i = 0; i < 2; i++) {
      const id = await t.run((ctx) =>
        manager.start(ctx, workflowRef, { fail }),
      );
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const status = await t.query((ctx) => getStatus(ctx, component, id));

      if (fail) {
        expect(status).toMatchObject({
          type: "failed",
          error: expect.stringContaining(
            "handler failed with globals disabled: true",
          ),
        });
      } else {
        expect(status).toEqual({ type: "completed", result: true });
      }
      for (const [index, key] of patchedKeys.entries()) {
        expect(global[key], key).toBe(originals[index].value);
        expect(Object.getOwnPropertyDescriptor(global, key), key).toEqual(
          originals[index].descriptor,
        );
      }
    }
  },
);
