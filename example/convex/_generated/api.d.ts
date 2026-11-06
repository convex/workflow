/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as catchError from "../catchError.js";
import type * as e2e from "../e2e.js";
import type * as example from "../example.js";
import type * as journalExample from "../journalExample.js";
import type * as nestedWorkflow from "../nestedWorkflow.js";
import type * as oversized from "../oversized.js";
import type * as passingSignals from "../passingSignals.js";
import type * as test_contextRoundtrip from "../test/contextRoundtrip.js";
import type * as test_inline from "../test/inline.js";
import type * as test_oldSyntax from "../test/oldSyntax.js";
import type * as transcription from "../transcription.js";
import type * as userConfirmation from "../userConfirmation.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  catchError: typeof catchError;
  e2e: typeof e2e;
  example: typeof example;
  journalExample: typeof journalExample;
  nestedWorkflow: typeof nestedWorkflow;
  oversized: typeof oversized;
  passingSignals: typeof passingSignals;
  "test/contextRoundtrip": typeof test_contextRoundtrip;
  "test/inline": typeof test_inline;
  "test/oldSyntax": typeof test_oldSyntax;
  transcription: typeof transcription;
  userConfirmation: typeof userConfirmation;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
