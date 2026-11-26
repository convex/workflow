#!/usr/bin/env node
/**
 * End-to-end test: starts real workflows via the Convex client,
 * subscribes to their status with a live query, and exits when
 * all workflows reach a terminal state.
 *
 * Usage:
 *   node example/e2e.mjs                          # uses CONVEX_URL from .env.local
 *   CONVEX_URL=https://... node example/e2e.mjs   # explicit URL
 */
import assert from "node:assert/strict";
import { ConvexClient } from "convex/browser";
import { api } from "./convex/_generated/api.js";
import { readFileSync } from "fs";

const TIMEOUT_MS = 60_000;
const APPROVAL_DELAY_MS = 5_000;

function isTerminal(s) {
  return s.type === "completed" || s.type === "canceled" || s.type === "failed";
}

// Load .env.local for CONVEX_URL
if (!process.env.CONVEX_URL) {
  try {
    const envLocal = readFileSync(".env.local", "utf-8");
    for (const line of envLocal.split("\n")) {
      const match = line.match(/^(\w+)=(.+?)(\s*#.*)?$/);
      if (match) process.env[match[1]] = match[2];
    }
  } catch {
    // .env.local not found, rely on env vars
  }
}

const url = process.env.CONVEX_URL;
if (!url) {
  console.error(
    "CONVEX_URL not set. Run from project root or set it explicitly.",
  );
  process.exit(1);
}

console.log(`Connecting to ${url}...`);
const client = new ConvexClient(url);

// Start all workflows
console.log("Starting workflows...");
const ids = await client.mutation(api.e2e.startAll, {});
for (const [name, id] of Object.entries(ids)) {
  console.log(`  ${name}: ${id}`);
  console.time(name);
}
console.time("oldSyntax");
const oldSyntaxWorkflow = client
  .action(api.test.oldSyntax.default)
  .then(() => console.timeEnd(`oldSyntax`));

// Schedule approval for the confirmation workflow after a delay.
// The workflow needs time to run generateProposals and create the event
// before we can approve it.
let approvalDone = false;
const approvalTimer = setTimeout(async () => {
  const tryApprove = async (attempt) => {
    try {
      console.log(`Approving confirmation workflow (attempt ${attempt})...`);
      await client.mutation(api.e2e.approveConfirmation, {
        workflowId: ids.confirmation,
      });
      approvalDone = true;
      console.log("Confirmation approved.");
    } catch (e) {
      const msg = e.message;
      if (attempt < 5 && !approvalDone) {
        console.log(`  Approval not ready: ${msg.slice(0, 80)}. Retrying...`);
        await new Promise((r) => setTimeout(r, 2000));
        return tryApprove(attempt + 1);
      }
      console.error(`  Approval failed after ${attempt} attempts: ${msg}`);
    }
  };
  await tryApprove(1);
}, APPROVAL_DELAY_MS);

const waiting = new Set(Object.keys(ids));
// Subscribe to status updates via live query
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`));
  }, TIMEOUT_MS);

  let lastLine = "";
  client.onUpdate(
    api.e2e.statusAll,
    { ids },
    (statuses) => {
      for (const [name, status] of Object.entries(statuses)) {
        if (status.type === "inProgress") continue;
        if (waiting.has(name)) {
          waiting.delete(name);
          console.timeEnd(name);
        }
      }
      const summary = Object.entries(statuses)
        .filter(([name]) => waiting.has(name))
        .map(([name, s]) => `${name}:${s.type.padEnd(25)}`)
        .join(" | ");
      if (summary !== lastLine) {
        lastLine = summary;
        console.log(summary);
      }

      if (Object.values(statuses).every(isTerminal)) {
        clearTimeout(timer);
        clearTimeout(approvalTimer);
        resolve(statuses);
      }
    },
    (error) => {
      clearTimeout(timer);
      clearTimeout(approvalTimer);
      reject(error);
    },
  );
});

try {
  const results = await done;
  console.log("\n=== Final Results ===");
  let allPassed = true;
  for (const [name, status] of Object.entries(results)) {
    const passed = status.type === "completed";
    if (!passed) allPassed = false;
    console.log(`  ${passed ? "PASS" : "FAIL"} ${name}: ${status.type}`);
    if (passed && status.result !== undefined) {
      console.log(`       result: ${JSON.stringify(status.result)}`);
    }
    if (status.type === "failed" && status.error) {
      console.log(`       error: ${status.error}`);
    }
  }
  if (results.parallelActions.type === "completed") {
    assert.deepEqual(results.parallelActions.result, {
      first: "echo:first",
      second: "echo:second",
      incremented: 3,
    });
  }
  await oldSyntaxWorkflow;
  console.log(
    allPassed ? "\nAll workflows passed!" : "\nSome workflows failed.",
  );
  await client.close();
  process.exit(allPassed ? 0 : 1);
} catch (e) {
  console.error("E2E test failed:", e.message);
  await client.close();
  process.exit(1);
}
