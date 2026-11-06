import { afterEach, describe, expect, test, vi } from "vitest";
import { convexToJson, v } from "convex/values";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";
import { storeOversizedResult } from "./oversizedValues.js";
import type { TransactionLimits } from "convex/server";
import { internalMutation } from "./_generated/server.js";

async function setup(
  limits?: Pick<TransactionLimits, "filesWritten" | "fileWriteBytes">,
) {
  const t = initConvexTest({ transactionLimits: limits ?? true });
  const ids = await t.run(async (ctx) => {
    const workflowId = await ctx.db.insert("workflows", {
      name: "oversized result",
      workflowHandle: "function://;oversizedValues.test:noop",
      args: {},
      generationNumber: 0,
    });
    const stepId = await ctx.db.insert("steps", {
      workflowId,
      stepNumber: 0,
      step: {
        kind: "function",
        functionType: "action",
        handle: "function://;oversizedValues.test:noop",
        name: "large result",
        args: {},
        argsSize: 2,
        inProgress: true,
        startedAt: Date.now(),
      },
    });
    return { workflowId, stepId };
  });
  return { t, ...ids };
}

async function completedOversizedStep() {
  const fixture = await setup();
  const { t, workflowId, stepId } = fixture;
  const value = "x".repeat(900_000);
  const storageId = await t.run(async (ctx) => {
    const runResult = await storeOversizedResult(
      ctx,
      { kind: "success", returnValue: value },
      { stepId },
    );
    const entry = await ctx.db.get("steps", stepId);
    if (!entry) throw new Error("Missing fixture step");
    await ctx.db.patch("steps", stepId, {
      step: {
        ...entry.step,
        inProgress: false,
        completedAt: Date.now(),
        runResult,
      },
    });
    await ctx.db.patch("workflows", workflowId, { runResult });
    const record = await ctx.db
      .query("oversizedValues")
      .withIndex("stepId", (q) => q.eq("stepId", stepId))
      .unique();
    if (!record) throw new Error("Missing stored value");
    return record.storageId;
  });
  return { ...fixture, storageId, value };
}

afterEach(() => vi.restoreAllMocks());

describe("oversized result storage", () => {
  test("uses Blob.size and accepts the exact remaining byte budget", async () => {
    const value = {
      text: "😀".repeat(220_000),
      bytes: new Uint8Array([0, 255]).buffer,
      bigint: 42n,
      infinity: Infinity,
    };
    const json = JSON.stringify(convexToJson(value));
    const size = new Blob([json]).size;
    expect(size).toBeGreaterThan(json.length);
    const { t, stepId } = await setup({
      filesWritten: 1,
      fileWriteBytes: size,
    });
    const result = await t.run(async (ctx) => {
      return storeOversizedResult(
        ctx,
        { kind: "success", returnValue: value },
        { stepId },
      );
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error).toContain(`stepId: "${stepId}"`);
      expect(result.error).not.toContain("Preview:");
    }
    expect(await t.mutation(api.oversizedValues.read, { stepId })).toEqual(
      value,
    );
    await t.run(async (ctx) => {
      const files = await ctx.db.system.query("_storage").take(2);
      expect(files).toHaveLength(1);
      expect(files[0].size).toBe(size);
      expect(await ctx.db.query("oversizedValues").take(2)).toHaveLength(1);
    });
  });

  test.each([
    { name: "byte budget", files: 1, delta: -1 },
    { name: "file count", files: 0, delta: 0 },
  ])(
    "fails without writing or scheduling when the $name is exhausted",
    async ({ files, delta }) => {
      const value = "x".repeat(900_000);
      const size = new Blob([JSON.stringify(value)]).size;
      const { t, stepId } = await setup({
        filesWritten: files,
        fileWriteBytes: size + delta,
      });
      const result = await t.run(async (ctx) => {
        const store = vi.spyOn(ctx.storage, "store");
        const schedule = vi.spyOn(ctx.scheduler, "runAfter");
        const result = await storeOversizedResult(
          ctx,
          { kind: "success", returnValue: value },
          { stepId },
        );
        expect(store).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
        return result;
      });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.error).toContain("Preview:");
        expect(result.error).toContain(`${size} bytes`);
        expect(result.error).not.toContain("Retrieve it");
      }
      await t.run(async (ctx) => {
        expect(await ctx.db.query("oversizedValues").take(1)).toEqual([]);
        expect(await ctx.db.system.query("_storage").take(1)).toEqual([]);
      });
    },
  );

  test("does not swallow unrelated storage failures", async () => {
    const { t, stepId } = await setup();
    await expect(
      t.run(async (ctx) => {
        vi.spyOn(ctx.storage, "store").mockRejectedValue(
          new Error("storage unavailable"),
        );
        return storeOversizedResult(
          ctx,
          { kind: "success", returnValue: "x".repeat(900_000) },
          { stepId },
        );
      }),
    ).rejects.toThrow("storage unavailable");
    await t.run(async (ctx) => {
      expect(await ctx.db.query("oversizedValues").take(1)).toEqual([]);
      expect(await ctx.db.system.query("_storage").take(1)).toEqual([]);
    });
  });

  test("workflow cleanup deletes the stored record and blob", async () => {
    const { t, workflowId, stepId, storageId } = await completedOversizedStep();
    expect(await t.mutation(api.workflow.cleanup, { workflowId })).toBe(true);
    await t.run(async (ctx) => {
      expect(await ctx.db.get("workflows", workflowId)).toBeNull();
      expect(await ctx.db.get("steps", stepId)).toBeNull();
      expect(await ctx.db.query("oversizedValues").take(1)).toEqual([]);
      expect(await ctx.db.system.get("_storage", storageId)).toBeNull();
      expect(await ctx.storage.get(storageId)).toBeNull();
    });
  });

  test("restarting from the failed step deletes its stored record and blob", async () => {
    const { t, workflowId, stepId, storageId } = await completedOversizedStep();
    await t.mutation(api.workflow.restart, { workflowId, from: 0 });
    await t.run(async (ctx) => {
      const workflow = await ctx.db.get("workflows", workflowId);
      expect(workflow?.generationNumber).toBe(1);
      expect(workflow?.runResult).toBeUndefined();
      expect(await ctx.db.get("steps", stepId)).toBeNull();
      expect(await ctx.db.query("oversizedValues").take(1)).toEqual([]);
      expect(await ctx.db.system.get("_storage", storageId)).toBeNull();
      expect(await ctx.storage.get(storageId)).toBeNull();
    });
  });

  test("rolling back removal preserves both the record and the readable blob", async () => {
    const { t, stepId, storageId, value } = await completedOversizedStep();
    await expect(
      t.mutation(async (ctx) => {
        await ctx.runMutation(api.oversizedValues.remove, { stepId });
        throw new Error("Intentional rollback");
      }),
    ).rejects.toThrow("Intentional rollback");
    expect(await t.mutation(api.oversizedValues.read, { stepId })).toBe(value);
    await t.run(async (ctx) => {
      const record = await ctx.db
        .query("oversizedValues")
        .withIndex("stepId", (q) => q.eq("stepId", stepId))
        .unique();
      expect(record?.storageId).toBe(storageId);
      expect(await ctx.db.system.get("_storage", storageId)).not.toBeNull();
    });
  });

  test.each([undefined, null, "small", 5n])(
    "leaves small values unchanged (%s)",
    async (value) => {
      const { t, stepId } = await setup();
      await t.run(async (ctx) => {
        const metrics = vi.spyOn(ctx.meta, "getTransactionMetrics");
        const result = { kind: "success" as const, returnValue: value ?? null };
        expect(await storeOversizedResult(ctx, result, { stepId })).toBe(
          result,
        );
        expect(metrics).not.toHaveBeenCalled();
      });
    },
  );
});

// Restart fixture: the workflow handler is a no-op so the test can inspect
// cleanup before any replacement steps are created.
export const noop = internalMutation({
  args: { workflowId: v.id("workflows"), generationNumber: v.number() },
  handler: () => null,
});
