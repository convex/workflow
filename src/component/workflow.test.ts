/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation } from "./_generated/server.js";
import { v } from "convex/values";
import { enqueueWorkflow, getWorkpool, handlerOnComplete } from "./pool.js";
import { WorkflowManager, type WorkflowComponent } from "../client/index.js";

describe("workflow", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test.each(
    ["start", "restart", "resume"].flatMap((route) =>
      ["success", "failed"].map((kind) => ({ route, kind })),
    ),
  )(
    "$route only calls handlerOnComplete for failed handlers ($kind)",
    async ({ route, kind }) => {
      const t = initConvexTest();
      // Keep the real callback implementation, while observing whether workpool
      // invokes it. A failure must still complete the workflow with an error.
      const callback = vi.spyOn(
        handlerOnComplete as typeof handlerOnComplete & {
          _handler: (...args: unknown[]) => unknown;
        },
        "_handler",
      );
      const id = await t.mutation(api.workflow.create, {
        workflowName: "callback exclusion",
        workflowHandle: `function://;workflow.test:${kind === "success" ? "noop" : "failingHandler"}`,
        workflowArgs: {},
        startAsync: route === "start",
        createOnly: route !== "start",
      });
      if (route === "restart") {
        await t.mutation(api.workflow.complete, {
          workflowId: id,
          generationNumber: 0,
          runResult: { kind: "failed", error: "previous attempt" },
        });
        await t.mutation(api.workflow.restart, {
          workflowId: id,
          startAsync: true,
        });
      } else if (route === "resume") {
        await t.run(async (ctx) => {
          const workflow = await ctx.db.get("workflows", id);
          await enqueueWorkflow(
            ctx,
            workflow!,
            await getWorkpool(ctx, undefined),
          );
        });
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      if (kind === "success") {
        expect(callback).not.toHaveBeenCalled();
      } else {
        expect(callback).toHaveBeenCalledOnce();
        const status = await t.query(api.workflow.getStatus, {
          workflowId: id,
        });
        expect(status.workflow.runResult).toMatchObject({
          kind: "failed",
          error: expect.stringContaining("handler failed"),
        });
      }
    },
  );

  test("can create a workflow async", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });
    const workflow = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow.workflow.name).toBe("test");
    expect(workflow.workflow.args).toEqual({ location: "San Francisco" });
    expect(workflow.workflow.runResult).toBeUndefined();
    expect(workflow.inProgress).toHaveLength(0);
  });

  test("create stores the definition version", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
      version: 2,
    });
    const { workflow } = await t.query(api.workflow.getStatus, {
      workflowId: id,
    });
    expect(workflow.version).toBe(2);
  });

  test("startSteps records the step version", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });
    await t.mutation(api.journal.startSteps, {
      workflowId: id,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "function" as const,
            functionType: "mutation" as const,
            handle: "function://;workflow.test:noop",
            name: "step1",
            inProgress: false,
            args: {},
            argsSize: 2,
            runResult: { kind: "success" as const, returnValue: null },
            startedAt: Date.now(),
            completedAt: Date.now(),
            version: 2,
          },
        },
      ],
    });
    const steps = await t.query(api.workflow.listSteps, {
      workflowId: id,
      order: "asc",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(steps.page).toHaveLength(1);
    expect(steps.page[0].version).toBe(2);
  });

  test("can cancel a workflow", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });
    const workflow = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow.workflow.runResult).toBeUndefined();
    await t.mutation(api.workflow.cancel, { workflowId: id });
    const workflow2 = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow2.workflow.runResult).toMatchObject({ kind: "canceled" });
  });

  test("retry a failed workflow", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });
    // Complete with failure
    await t.mutation(api.workflow.complete, {
      workflowId: id,
      generationNumber: 0,
      runResult: { kind: "failed", error: "something went wrong" },
    });
    const before = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(before.workflow.runResult).toMatchObject({ kind: "failed" });
    expect(before.workflow.generationNumber).toBe(0);

    // Retry
    await t.mutation(api.workflow.restart, {
      workflowId: id,
      startAsync: true,
    });
    const after = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(after.workflow.runResult).toBeUndefined();
    expect(after.workflow.generationNumber).toBe(1);
  });

  test("retry throws if workflow is still running", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });
    await expect(
      t.mutation(api.workflow.restart, { workflowId: id, startAsync: true }),
    ).rejects.toThrow("still running");
  });

  test("retry from step number deletes steps from that point", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });
    // Insert some steps
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("steps", {
          workflowId: id,
          stepNumber: i,
          step: {
            kind: "function" as const,
            functionType: "mutation" as const,
            handle: "function://;workflow.test:noop",
            name: `step${i}`,
            inProgress: false,
            argsSize: 0,
            args: {},
            runResult: { kind: "success", returnValue: null },
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        });
      }
    });
    // Complete with failure
    await t.mutation(api.workflow.complete, {
      workflowId: id,
      generationNumber: 0,
      runResult: { kind: "failed", error: "step2 failed" },
    });

    // Retry from step 1
    await t.mutation(api.workflow.restart, {
      workflowId: id,
      from: 1,
      startAsync: true,
    });

    // Only step0 should remain
    await t.run(async (ctx) => {
      const steps = await ctx.db
        .query("steps")
        .withIndex("workflow", (q) => q.eq("workflowId", id))
        .collect();
      expect(steps).toHaveLength(1);
      expect(steps[0].stepNumber).toBe(0);
      expect(steps[0].step.name).toBe("step0");
    });
  });

  test("retry from step name deletes that step and subsequent ones", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });
    // Insert steps with names
    await t.run(async (ctx) => {
      const names = ["fetch", "process", "save"];
      for (let i = 0; i < names.length; i++) {
        await ctx.db.insert("steps", {
          workflowId: id,
          stepNumber: i,
          step: {
            kind: "function" as const,
            functionType: "action" as const,
            handle: "function://;workflow.test:noop",
            name: names[i],
            inProgress: false,
            argsSize: 0,
            args: {},
            runResult: { kind: "success", returnValue: null },
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        });
      }
    });
    await t.mutation(api.workflow.complete, {
      workflowId: id,
      generationNumber: 0,
      runResult: { kind: "failed", error: "save failed" },
    });

    // Retry from "process"
    await t.mutation(api.workflow.restart, {
      workflowId: id,
      from: "process",
      startAsync: true,
    });

    // Only "fetch" (step 0) should remain
    await t.run(async (ctx) => {
      const steps = await ctx.db
        .query("steps")
        .withIndex("workflow", (q) => q.eq("workflowId", id))
        .collect();
      expect(steps).toHaveLength(1);
      expect(steps[0].step.name).toBe("fetch");
    });
  });

  test("retry from unknown step name throws", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });
    await t.mutation(api.workflow.complete, {
      workflowId: id,
      generationNumber: 0,
      runResult: { kind: "failed", error: "oops" },
    });
    await expect(
      t.mutation(api.workflow.restart, {
        workflowId: id,
        from: "nonexistent",
        startAsync: true,
      }),
    ).rejects.toThrow('Step "nonexistent" not found');
  });

  test("retry from negative step number throws", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });
    await t.mutation(api.workflow.complete, {
      workflowId: id,
      generationNumber: 0,
      runResult: { kind: "failed", error: "oops" },
    });
    await expect(
      t.mutation(api.workflow.restart, {
        workflowId: id,
        from: -1,
        startAsync: true,
      }),
    ).rejects.toThrow("Step number cannot be negative: -1");
  });

  test("retry deletes associated event steps", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });
    // Insert an event and an event step referencing it
    let eventId: any;
    await t.run(async (ctx) => {
      eventId = await ctx.db.insert("events", {
        workflowId: id,
        name: "approval",
        state: { kind: "created" },
      });
      await ctx.db.insert("steps", {
        workflowId: id,
        stepNumber: 0,
        step: {
          kind: "event" as const,
          name: "waitForApproval",
          inProgress: false,
          argsSize: 0,
          args: { eventId },
          eventId,
          startedAt: Date.now(),
          completedAt: Date.now(),
          runResult: { kind: "success", returnValue: null },
        },
      });
    });
    await t.mutation(api.workflow.complete, {
      workflowId: id,
      generationNumber: 0,
      runResult: { kind: "failed", error: "oops" },
    });

    // Retry from step 0 — should delete the event too
    await t.mutation(api.workflow.restart, {
      workflowId: id,
      from: 0,
      startAsync: true,
    });
    await t.run(async (ctx) => {
      const steps = await ctx.db
        .query("steps")
        .withIndex("workflow", (q) => q.eq("workflowId", id))
        .collect();
      expect(steps).toHaveLength(0);
      const event = await ctx.db.get("events", eventId);
      expect(event).toBeNull();
    });
  });

  test("cleaning up a workflow", async () => {
    const t = initConvexTest();
    const id = await t.mutation(api.workflow.create, {
      workflowName: "test",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });
    const workflow = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow.workflow.runResult).toBeUndefined();
    await t.mutation(api.workflow.cancel, { workflowId: id });
    const workflow2 = await t.query(api.workflow.getStatus, { workflowId: id });
    expect(workflow2.workflow.runResult).toMatchObject({ kind: "canceled" });
    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId: id });
    expect(cleaned).toBe(true);
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get("workflows", id);
      expect(workflow).toBeNull();
    });
  });

  test("cleanup deletes associated events", async () => {
    const t = initConvexTest();

    // Create a workflow
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "test-with-event",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create an event associated with the workflow
    const eventId = await t.mutation(api.event.create, {
      name: "test-event",
      workflowId,
    });

    // Create a step entry with kind "event" that references the event using startSteps API
    const entries = await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "event" as const,
            name: "test-event-step",
            inProgress: true,
            argsSize: 0,
            args: { eventId },
            startedAt: Date.now(),
          },
        },
      ],
    });
    const stepId = entries[0]._id as Id<"steps">;

    // Verify event exists
    await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      expect(event).not.toBeNull();
    });

    // Cancel the workflow so it can be cleaned up
    await t.mutation(api.workflow.cancel, { workflowId });

    // Clean up the workflow
    const cleaned = await t.mutation(api.workflow.cleanup, {
      workflowId,
    });
    expect(cleaned).toBe(true);

    // Verify the workflow is deleted
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get("workflows", workflowId);
      expect(workflow).toBeNull();
    });

    // Verify the step is deleted
    await t.run(async (ctx) => {
      const step = await ctx.db.get("steps", stepId);
      expect(step).toBeNull();
    });

    // Verify the event is deleted
    await t.run(async (ctx) => {
      const event = await ctx.db.get("events", eventId);
      expect(event).toBeNull();
    });
  });

  test("nested workflow starts reuse the shared parallelism configuration", async () => {
    const t = initConvexTest();
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "parent-workflow",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      maxParallelism: 2,
      createOnly: true,
    });

    const entries = await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "workflow",
            name: "nested-workflow",
            handle: "function://;workflow.test:nestedWorkflow",
            inProgress: true,
            argsSize: 0,
            args: {},
            startedAt: Date.now(),
          },
        },
      ],
    });
    const step = entries[0].step;
    if (step.kind !== "workflow" || !step.workflowId) {
      throw new Error("Missing child workflow");
    }
    const child = await t.query(api.workflow.getStatus, {
      workflowId: step.workflowId,
    });
    expect(child.workflow.runResult).toBeUndefined();
    expect(child.inProgress).toHaveLength(0);
    const config = await t.run((ctx) => ctx.db.query("config").unique());
    expect(config?.maxParallelism).toBe(2);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const completed = await t.query(api.workflow.getStatus, {
      workflowId: step.workflowId,
    });
    expect(completed.workflow.runResult).toEqual({
      kind: "success",
      returnValue: null,
    });
    const finalConfig = await t.run((ctx) => ctx.db.query("config").unique());
    expect(finalConfig?.maxParallelism).toBe(2);
  });

  test("cleanup enqueues cleanup for nested workflows", async () => {
    const t = initConvexTest();

    // Create a parent workflow
    const parentWorkflowId = await t.mutation(api.workflow.create, {
      workflowName: "parent-workflow",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create a workflow step which will automatically create a nested workflow via startSteps
    // The startSteps handler creates the nested workflow when kind is "workflow"
    const entries = await t.mutation(api.journal.startSteps, {
      workflowId: parentWorkflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "workflow" as const,
            name: "nested-workflow-step",
            handle: "function://;workflow.test:nestedWorkflow",
            inProgress: true,
            argsSize: 0,
            args: { location: "New York" },
            startedAt: Date.now(),
          },
        },
      ],
    });
    const stepId = entries[0]._id as Id<"steps">;

    // Get the nested workflow ID that was created by startSteps
    let nestedWorkflowId: Id<"workflows"> | undefined;
    await t.run(async (ctx) => {
      const step = await ctx.db.get("steps", stepId);
      if (step && step.step.kind === "workflow") {
        nestedWorkflowId = step.step.workflowId;
      }
    });
    expect(nestedWorkflowId).toBeDefined();

    // Cancel parent workflow - this should automatically cancel nested workflows
    await t.mutation(api.workflow.cancel, { workflowId: parentWorkflowId });

    // Verify nested workflow was also canceled automatically
    await t.run(async (ctx) => {
      const nested = await ctx.db.get("workflows", nestedWorkflowId!);
      expect(nested?.runResult).toBeDefined();
    });

    // Verify both workflows exist before cleanup
    await t.run(async (ctx) => {
      const parent = await ctx.db.get("workflows", parentWorkflowId);
      const nested = await ctx.db.get("workflows", nestedWorkflowId!);
      expect(parent).not.toBeNull();
      expect(nested).not.toBeNull();
    });

    // Clean up the parent workflow
    const cleaned = await t.mutation(api.workflow.cleanup, {
      workflowId: parentWorkflowId,
    });
    expect(cleaned).toBe(true);

    // Verify the parent workflow is deleted
    await t.run(async (ctx) => {
      const parent = await ctx.db.get("workflows", parentWorkflowId);
      expect(parent).toBeNull();
    });

    // Verify the step is deleted
    await t.run(async (ctx) => {
      const step = await ctx.db.get("steps", stepId);
      expect(step).toBeNull();
    });

    // The nested workflow cleanup is enqueued via workpool.
    // Run scheduled functions to process the cleanup.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Verify the nested workflow is also cleaned up
    await t.run(async (ctx) => {
      const nested = await ctx.db.get("workflows", nestedWorkflowId!);
      expect(nested).toBeNull();
    });
  });

  test("cleanup handles workflow step without workflowId", async () => {
    const t = initConvexTest();

    // Create a workflow
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "test-workflow",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Seed the pending step directly: startSteps always starts the child now.
    const stepId = await t.run((ctx) =>
      ctx.db.insert("steps", {
        workflowId,
        stepNumber: 0,
        step: {
          kind: "workflow",
          name: "pending-nested-workflow",
          handle: "function://;workflow.test:noop",
          inProgress: true,
          argsSize: 0,
          args: { location: "Boston" },
          startedAt: Date.now(),
        },
      }),
    );

    const entry = await t.run((ctx) => ctx.db.get("steps", stepId));
    expect(entry?.step).toMatchObject({ kind: "workflow" });
    expect(entry?.step).not.toHaveProperty("workflowId");

    // Cancel the workflow
    await t.mutation(api.workflow.cancel, { workflowId });

    // Cleanup should succeed without errors
    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId });
    expect(cleaned).toBe(true);

    // Verify the workflow and pending step are deleted
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get("workflows", workflowId);
      expect(workflow).toBeNull();
      expect(await ctx.db.get("steps", stepId)).toBeNull();
    });
  });

  test("cleanup handles event step without eventId", async () => {
    const t = initConvexTest();

    // Create a workflow
    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "test-workflow",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create an event step that starts waiting (no event sent yet, so it won't have a response)
    await t.mutation(api.journal.startSteps, {
      workflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "event" as const,
            name: "pending-event",
            inProgress: true,
            argsSize: 0,
            args: {},
            startedAt: Date.now(),
          },
        },
      ],
    });

    // Cancel the workflow
    await t.mutation(api.workflow.cancel, { workflowId });

    // Cleanup should succeed without errors (eventId is set by awaitEvent)
    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId });
    expect(cleaned).toBe(true);

    // Verify the workflow is deleted
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get("workflows", workflowId);
      expect(workflow).toBeNull();
    });
  });

  test("cleanup deletes large numbers of steps via async iteration", async () => {
    const t = initConvexTest();

    const workflowId = await t.mutation(api.workflow.create, {
      workflowName: "test-many-steps",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: {},
      startAsync: true,
    });

    // Insert many steps so the async iteration walks through them all and
    // (in environments that enforce limits) any continuation kicks in.
    const stepCount = 100;
    await t.run(async (ctx) => {
      for (let i = 0; i < stepCount; i++) {
        await ctx.db.insert("steps", {
          workflowId,
          stepNumber: i,
          step: {
            kind: "function" as const,
            functionType: "mutation" as const,
            handle: "function://;workflow.test:noop",
            name: `step${i}`,
            inProgress: false,
            argsSize: 0,
            args: {},
            runResult: { kind: "success", returnValue: null },
            startedAt: Date.now(),
            completedAt: Date.now(),
          },
        });
      }
    });

    await t.mutation(api.workflow.cancel, { workflowId });

    const cleaned = await t.mutation(api.workflow.cleanup, { workflowId });
    expect(cleaned).toBe(true);

    // Drain any continuations scheduled when budget was halfway consumed.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.run(async (ctx) => {
      const workflow = await ctx.db.get("workflows", workflowId);
      expect(workflow).toBeNull();
      const remaining = await ctx.db
        .query("steps")
        .withIndex("workflow", (q) => q.eq("workflowId", workflowId))
        .collect();
      expect(remaining).toHaveLength(0);
    });
  });

  test("cleanup with mixed event and workflow steps", async () => {
    const t = initConvexTest();

    // Create parent workflow
    const parentWorkflowId = await t.mutation(api.workflow.create, {
      workflowName: "parent-workflow",
      workflowHandle: "function://;workflow.test:noop",
      workflowArgs: { location: "San Francisco" },
      startAsync: true,
    });

    // Create an event
    const eventId = await t.mutation(api.event.create, {
      name: "test-event",
      workflowId: parentWorkflowId,
    });

    // Create mixed steps using startSteps API
    // The workflow step will automatically create a nested workflow
    const entries = await t.mutation(api.journal.startSteps, {
      workflowId: parentWorkflowId,
      generationNumber: 0,
      steps: [
        {
          step: {
            kind: "event" as const,
            name: "event-step",
            inProgress: true,
            argsSize: 0,
            args: { eventId },
            startedAt: Date.now(),
          },
        },
        {
          step: {
            kind: "workflow" as const,
            name: "workflow-step",
            handle: "function://;workflow.test:nestedWorkflow",
            inProgress: true,
            argsSize: 0,
            args: { location: "New York" },
            startedAt: Date.now(),
          },
        },
      ],
    });

    // Get the nested workflow ID that was created by startSteps
    const workflowStepId = entries[1]._id as Id<"steps">;
    let nestedWorkflowId: Id<"workflows"> | undefined;
    await t.run(async (ctx) => {
      const step = await ctx.db.get("steps", workflowStepId);
      if (step && step.step.kind === "workflow") {
        nestedWorkflowId = step.step.workflowId;
      }
    });
    expect(nestedWorkflowId).toBeDefined();

    // Cancel parent workflow - this should automatically cancel nested workflows
    await t.mutation(api.workflow.cancel, { workflowId: parentWorkflowId });

    // Verify nested workflow was also canceled automatically
    await t.run(async (ctx) => {
      const nested = await ctx.db.get("workflows", nestedWorkflowId!);
      expect(nested?.runResult).toBeDefined();
    });

    // Verify resources exist before cleanup
    await t.run(async (ctx) => {
      const parent = await ctx.db.get("workflows", parentWorkflowId);
      const nested = await ctx.db.get("workflows", nestedWorkflowId!);
      const event = await ctx.db.get("events", eventId);
      expect(parent).not.toBeNull();
      expect(nested).not.toBeNull();
      expect(event).not.toBeNull();
    });

    // Clean up the parent workflow
    const cleaned = await t.mutation(api.workflow.cleanup, {
      workflowId: parentWorkflowId,
    });
    expect(cleaned).toBe(true);

    // Run scheduled functions to process nested cleanup
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Verify all resources are cleaned up
    await t.run(async (ctx) => {
      const parent = await ctx.db.get("workflows", parentWorkflowId);
      const nested = await ctx.db.get("workflows", nestedWorkflowId!);
      const event = await ctx.db.get("events", eventId);
      expect(parent).toBeNull();
      expect(nested).toBeNull();
      expect(event).toBeNull();
    });
  });
});

export const noop = internalMutation({ args: v.any(), handler: () => {} });

export const failingHandler = internalMutation({
  args: { workflowId: v.id("workflows"), generationNumber: v.number() },
  returns: v.null(),
  handler: () => {
    throw new Error("handler failed");
  },
});

export const nestedWorkflow = new WorkflowManager(
  api as unknown as WorkflowComponent,
)
  .define({ args: { location: v.optional(v.string()) }, returns: v.null() })
  .handler(async () => null);
