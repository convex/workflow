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
export function initConvexTest() {
  const t = convexTest(schema, modules);
  // These tests run workflow as the app, which receives no args, so the
  // workpool's forwarded args can't resolve until convex/convex#62122.
  workpool.register(t, "workpool", {});
  return t;
}

test("setup", () => {});
