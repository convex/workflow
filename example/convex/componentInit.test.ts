/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import workflow from "@convex-dev/workflow/test";
import schema from "./schema";
import { initConvexTest, modules } from "./setup.test";

function readWorkpoolGlobals(t: ReturnType<typeof convexTest>) {
  return (t as any).runInComponent("workflow/workpool", (ctx: any) =>
    ctx.db.query("globals").unique(),
  );
}

describe("workflow init args", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("forwards the app's args to the workpool's init", async () => {
    const t = initConvexTest();
    await t.runInits();
    expect(await readWorkpoolGlobals(t)).toMatchObject({
      maxParallelism: 20,
      logLevel: "WARN",
    });
  });

  test.skip("leaves the workpool on its defaults when the app passes no args (needs convex/convex#62122)", async () => {
    const t = convexTest({
      schema,
      modules,
      componentArgs: { workflow: {} },
    });
    workflow.register(t);
    await t.runInits();
    expect((await readWorkpoolGlobals(t))?.maxParallelism).toBeUndefined();
  });
});
