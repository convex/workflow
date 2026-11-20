import { defineApp } from "convex/server";
import { expect, test } from "vitest";
import workflow from "./convex.config.js";

// Checked by `tsc` (npm run typecheck); vitest only runs the body.
test("init args are type-checked in use()", () => {
  const app = defineApp();
  const uses = () => {
    app.use(workflow, { args: { maxParallelism: 10, logLevel: "INFO" } });
    // @ts-expect-error maxParallelism is a number
    app.use(workflow, { args: { maxParallelism: "10" } });
  };
  expect(uses).toBeTypeOf("function");
});
