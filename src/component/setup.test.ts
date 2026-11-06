/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import workpool from "@convex-dev/workpool/test";
import schema from "./schema.js";
export const modules = import.meta.glob("./**/*.*s");

// set up nested workpool
import componentSchema from "../../node_modules/@convex-dev/workpool/src/component/schema.js";
export { componentSchema };
export const componentModules = import.meta.glob(
  "../../node_modules/@convex-dev/workpool/src/component/**/*.ts",
);
export function initConvexTest(options?: {
  transactionLimits?: Parameters<typeof convexTest>[0]["transactionLimits"];
}) {
  const t = convexTest({ schema, modules, ...options });
  workpool.register(t, "workpool");
  return t;
}

test("setup", () => {});
