import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import {
  anyApi,
  componentsGeneric,
  defineSchema,
  internalMutationGeneric,
  type FunctionReference,
} from "convex/server";
import { v } from "convex/values";
import {
  start,
  WorkflowManager,
  type WorkflowComponent,
  type WorkflowId,
} from "./index.js";
import workflowTest from "../test.js";

const component = componentsGeneric().workflow as unknown as WorkflowComponent;
const manager = new WorkflowManager(component);
type WorkflowRef = FunctionReference<
  "mutation",
  "internal",
  { args: Record<string, never>; startAsync?: boolean },
  WorkflowId
>;
const childRef = anyApi.versions.child as WorkflowRef;
const parentRef = anyApi.versions.parent as WorkflowRef;
const unversionedRef = anyApi.versions.unversioned as WorkflowRef;
const functions = {
  child: manager
    .define({ args: {}, version: 3, returns: v.number() })
    .handler(async (step) => {
      await step.runMutation(anyApi.versions.value, {});
      return step.journal.getVersion();
    }),
  parent: manager
    .define({ args: {}, version: 7, returns: v.number() })
    .handler(async (step): Promise<number> => {
      return (await step.runWorkflow(childRef, {})) as number;
    }),
  unversioned: manager
    .define({ args: {}, returns: v.number() })
    .handler(async (step) => {
      await step.runMutation(anyApi.versions.value, {});
      return step.journal.getVersion();
    }),
  value: internalMutationGeneric({
    args: {},
    returns: v.number(),
    handler: () => 42,
  }),
};

function setup() {
  const t = convexTest(defineSchema({}), {
    "./_generated/api.ts": async () => ({}),
    "./versions.ts": async () => functions,
  });
  workflowTest.register(t);
  return t;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each(["direct", "start", "manager"] as const)(
  "%s preserves the defined version at creation and during execution",
  async (method) => {
    for (const startAsync of [false, true]) {
      const t = setup();
      const id =
        method === "direct"
          ? await t.mutation(childRef, { args: {}, startAsync })
          : await t.run((ctx) =>
              method === "start"
                ? start(ctx, childRef, {}, { startAsync })
                : manager.start(ctx, childRef, {}, { startAsync }),
            );
      const before = await t.query(component.workflow.getStatus, {
        workflowId: id,
      });
      expect(before.workflow.version).toBe(3);
      expect(before.workflow.runResult).toBeUndefined();
      if (startAsync) expect(before.inProgress).toHaveLength(0);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const after = await t.query(component.workflow.getStatus, {
        workflowId: id,
      });
      expect(after.workflow.version).toBe(3);
      expect(after.workflow.runResult).toEqual({
        kind: "success",
        returnValue: 3,
      });
      const steps = await t.query(component.workflow.listSteps, {
        workflowId: id,
        order: "asc",
        paginationOpts: { cursor: null, numItems: 10 },
      });
      expect(steps.page.map((step) => step.version)).toEqual([3]);
    }
  },
);

test("nested workflows use the child's version before its handler runs", async () => {
  const t = setup();
  const id = await t.run((ctx) => manager.start(ctx, parentRef, {}));
  const parent = await t.query(component.workflow.getStatus, {
    workflowId: id,
  });
  expect(parent.workflow.version).toBe(7);
  const steps = await t.query(component.workflow.listSteps, {
    workflowId: id,
    order: "asc",
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(steps.page).toHaveLength(1);
  const childStep = steps.page[0];
  expect(childStep.version).toBe(7);
  expect(childStep.kind).toBe("workflow");
  if (childStep.kind !== "workflow" || !childStep.nestedWorkflowId)
    throw new Error("Missing child workflow");
  const child = await t.query(component.workflow.getStatus, {
    workflowId: childStep.nestedWorkflowId,
  });
  expect(child.workflow.version).toBe(3);
  expect(child.workflow.runResult).toBeUndefined();
  expect(child.inProgress).toHaveLength(0);

  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const completed = await t.query(component.workflow.getStatus, {
    workflowId: id,
  });
  expect(completed.workflow.runResult).toEqual({
    kind: "success",
    returnValue: 3,
  });
  const childSteps = await t.query(component.workflow.listSteps, {
    workflowId: childStep.nestedWorkflowId,
    order: "asc",
    paginationOpts: { cursor: null, numItems: 10 },
  });
  expect(childSteps.page.map((step) => step.version)).toEqual([3]);
});

test("unversioned definitions still use zero", async () => {
  const t = setup();
  const id = await t.run((ctx) =>
    manager.start(ctx, unversionedRef, {}, { startAsync: true }),
  );
  const before = await t.query(component.workflow.getStatus, {
    workflowId: id,
  });
  expect(before.workflow.version).toBe(0);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const after = await t.query(component.workflow.getStatus, { workflowId: id });
  expect(after.workflow.runResult).toEqual({ kind: "success", returnValue: 0 });
});

test("a version guard consumes a removed step from a journal shorter than the channel capacity", async () => {
  const replayRef = anyApi.versions.replay as WorkflowRef;
  const replayFunctions = {
    ...functions,
    replay: manager
      .define({ args: {}, version: 1, returns: v.array(v.number()) })
      .handler(async (step) => {
        await step.runMutation(
          anyApi.versions.value,
          {},
          { name: "removed", inline: true },
        );
        await step.awaitEvent({ name: "resume" });
        return [];
      }),
  };
  const t = convexTest(defineSchema({}), {
    "./_generated/api.ts": async () => ({}),
    "./versions.ts": async () => replayFunctions,
  });
  workflowTest.register(t);

  const id = await t.run((ctx) => manager.start(ctx, replayRef, {}));
  const before = await t.query(component.workflow.listSteps, {
    workflowId: id,
    order: "asc",
    paginationOpts: { cursor: null, numItems: 10 },
  });
  // Both entries fit inside the default channel capacity of ten.
  expect(before.page.map(({ name, version }) => ({ name, version }))).toEqual([
    { name: "removed", version: 1 },
    { name: "resume", version: 1 },
  ]);

  // Simulate deploying v2 while this v1 workflow is waiting for its event.
  replayFunctions.replay = manager
    .define({ args: {}, version: 2, returns: v.array(v.number()) })
    .handler(async (step) => {
      const versions = [step.journal.getVersion()];
      if (step.journal.getVersion() < 2) {
        await step.journal.consumeNext("removed");
      }
      versions.push(step.journal.getVersion());
      await step.awaitEvent({ name: "resume" });
      versions.push(step.journal.getVersion());
      return versions;
    });

  await t.run((ctx) =>
    manager.sendEvent(ctx, { workflowId: id, name: "resume" }),
  );
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const after = await t.query(component.workflow.getStatus, { workflowId: id });
  expect(after.workflow.runResult).toEqual({
    kind: "success",
    returnValue: [1, 1, 2],
  });
});
