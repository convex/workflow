import { readFileSync, writeFileSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const input = process.argv[2] ?? "experiments/workpool/results.json";
const results = JSON.parse(readFileSync(input, "utf8"));
const samples = results.samples;
for (const sample of samples)
  sample.executions = {
    scheduledCommits: 0,
    retries: 0,
    errors: 0,
    wrappers: 0,
    separateCompletions: 0,
    scheduledSuccessCallbacks: 0,
    databaseReadBytes: 0,
    databaseWriteBytes: 0,
    lastWorkCommitAt: 0,
    byFunction: {},
  };
const lines = createInterface({
  input: createReadStream(input.replace(/\.json$/, "") + ".logs.jsonl"),
  crlfDelay: Infinity,
});
const seen = new Set();
for await (const line of lines) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry.kind !== "Completion") continue;
  // Stream reconnects can replay entries. Retry attempts share execution IDs,
  // so include the completion timestamp when deduplicating.
  const key = `${entry.executionId}/${entry.timestamp}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const at = entry.timestamp * 1000;
  const sample = samples.find((s) => at >= s.from && at <= s.drainedAt);
  if (!sample) continue;
  const component =
    sample.workload === "pool"
      ? ["baseline", "filtered"].includes(sample.mode)
        ? "poolBaseline"
        : "poolPr"
      : sample.mode;
  if (
    entry.componentPath &&
    entry.componentPath !== component &&
    !entry.componentPath.startsWith(`${component}/`)
  )
    continue;
  const x = sample.executions;
  if (entry.willRetry) x.retries++;
  if (entry.error && !entry.willRetry) x.errors++;
  if (entry.caller !== "Scheduler" || entry.willRetry || entry.error) continue;
  x.scheduledCommits++;
  x.databaseReadBytes += entry.usageStats?.databaseReadBytes ?? 0;
  x.databaseWriteBytes += entry.usageStats?.databaseWriteBytes ?? 0;
  const name = `${entry.componentPath ?? "app"}/${entry.identifier}`;
  x.byFunction[name] = (x.byFunction[name] ?? 0) + 1;
  if (entry.identifier === "worker:runMutationWrapper") x.wrappers++;
  if (entry.identifier === "complete:complete") x.separateCompletions++;
  if (
    ["benchmark:ignoredSuccess", "pool:handlerOnComplete"].includes(
      entry.identifier,
    )
  )
    x.scheduledSuccessCallbacks++;
  if (
    [
      "worker:runMutationWrapper",
      "complete:complete",
      "benchmark:ignoredSuccess",
      "pool:handlerOnComplete",
      "pool:onComplete",
    ].includes(entry.identifier)
  )
    x.lastWorkCommitAt = Math.max(x.lastWorkCommitAt, at);
}
for (const sample of samples) {
  // This also detects incomplete/truncated log capture before reporting costs.
  const expectedWrappers =
    sample.count *
    (sample.workload === "pool"
      ? 1
      : sample.workload === "inline"
        ? 1
        : sample.workload === "action"
          ? sample.steps + 1
          : 2 * sample.steps + 1);
  assert.equal(
    sample.executions.wrappers,
    expectedWrappers,
    `Incomplete wrapper logs: ${sample.run}`,
  );
  const expectedCompletions =
    sample.mode === "allMutations"
      ? 0
      : sample.mode === "transactional"
        ? sample.workload === "pool" || sample.workload === "inline"
          ? 0
          : sample.count * sample.steps
        : sample.workload === "action"
          ? sample.count * (sample.steps + 1)
          : expectedWrappers;
  // Action completion has a different path; assert mutation-only workloads.
  if (sample.workload !== "action")
    assert.equal(
      sample.executions.separateCompletions,
      expectedCompletions,
      `Unexpected completion count: ${sample.run}`,
    );
  assert.equal(sample.executions.errors, 0, `Runtime errors: ${sample.run}`);
  assert.equal(
    sample.executions.scheduledSuccessCallbacks,
    sample.mode === "baseline"
      ? sample.count *
          (sample.workload === "pool" || sample.workload === "inline"
            ? 1
            : sample.steps + 1)
      : 0,
    `Unexpected success callback count: ${sample.run}`,
  );
  sample.committedExecutionMs =
    sample.executions.lastWorkCommitAt - sample.admittedAt;
  sample.committedThroughput =
    (sample.count * (sample.workload === "pool" ? 1 : sample.steps) * 1000) /
    sample.committedExecutionMs;
  sample.endToEndThroughput =
    (sample.count * (sample.workload === "pool" ? 1 : sample.steps) * 1000) /
    (sample.admissionMs + sample.committedExecutionMs);
}

const median = (xs) => {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const groups = Map.groupBy(
  samples.filter((s) => s.round >= 0),
  (s) => `${s.workload}/${s.maxParallelism}/${s.mode}`,
);
results.summary = Array.from(groups, ([key, xs]) => ({
  key,
  trials: xs.length,
  medianThroughput: median(xs.map((s) => s.throughput)),
  medianCommittedThroughput: median(xs.map((s) => s.committedThroughput)),
  minCommittedThroughput: Math.min(...xs.map((s) => s.committedThroughput)),
  maxCommittedThroughput: Math.max(...xs.map((s) => s.committedThroughput)),
  medianCommittedExecutionMs: median(xs.map((s) => s.committedExecutionMs)),
  medianEndToEndThroughput: median(xs.map((s) => s.endToEndThroughput)),
  medianAdmissionMs: median(xs.map((s) => s.admissionMs)),
  minThroughput: Math.min(...xs.map((s) => s.throughput)),
  maxThroughput: Math.max(...xs.map((s) => s.throughput)),
  medianElapsedMs: median(xs.map((s) => s.elapsedMs)),
  medianScheduledCommits: median(xs.map((s) => s.executions.scheduledCommits)),
  medianRetries: median(xs.map((s) => s.executions.retries)),
}));
writeFileSync(input, JSON.stringify(results, null, 2) + "\n");
console.table(
  results.summary.map((s) => ({
    scenario: s.key,
    "jobs or steps / s": s.medianThroughput.toFixed(1),
    range: `${s.minThroughput.toFixed(1)}–${s.maxThroughput.toFixed(1)}`,
    "scheduled commits": s.medianScheduledCommits,
    retries: s.medianRetries,
    "committed / s": s.medianCommittedThroughput.toFixed(1),
  })),
);
