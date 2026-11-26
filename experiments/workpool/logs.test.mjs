import { afterEach, expect, test } from "vitest";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CallbackLog } from "./logs.mjs";

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function watch() {
  const input = new PassThrough();
  const log = new CallbackLog(input, "test.logs.jsonl");
  cleanups.push(async () => {
    input.end();
    await log.done;
  });
  return {
    input,
    log,
    emit: (entry) => input.write(JSON.stringify(entry) + "\n"),
  };
}

function completion(executionId, overrides = {}) {
  return {
    kind: "Completion",
    caller: "Scheduler",
    executionId,
    timestamp: 2,
    identifier: "benchmark:ignoredSuccess",
    componentPath: null,
    ...overrides,
  };
}

test.each(["pool", "mutation", "action", "inline"])(
  "waits for the final %s callback after the pool has drained",
  async (workload) => {
    const { input, log, emit } = watch();
    const sample = {
      mode: "baseline",
      legacyCallbacks: true,
      workload,
      count: 2,
      steps: 2,
      from: 1000,
      run: "trial",
    };
    const expected = workload === "pool" || workload === "inline" ? 2 : 6;
    const callback =
      workload === "pool"
        ? {}
        : { componentPath: "baseline", identifier: "pool:handlerOnComplete" };
    let advanced = false;
    const drained = log.waitFor(sample).then(() => {
      advanced = true;
    });

    emit(completion("previous trial", { ...callback, timestamp: 0.5 }));
    emit(
      completion("wrong component", {
        ...callback,
        componentPath: "anotherPool",
      }),
    );
    emit(completion("nested call", { ...callback, caller: "Function" }));
    emit(
      completion("failed attempt", {
        ...callback,
        error: "OCC",
        willRetry: true,
      }),
    );
    emit(completion("failed callback", { ...callback, error: "failure" }));
    for (let i = 0; i < expected - 1; i++) {
      const record = completion(`current-${i}`, callback);
      emit(record);
      emit(record); // A reconnect replay must not satisfy the missing callback.
    }
    await sleep(60);
    expect(advanced).toBe(false);

    // Exercise split stream chunks, including a callback that arrives well after
    // the caller observed an idle pool. No next trial is allowed until this log.
    const last = JSON.stringify(completion("last", callback));
    input.write(last.slice(0, 12));
    input.write(last.slice(12) + "\n");
    await drained;
    expect(advanced).toBe(true);
  },
);

test("fails the callback wait when the stream ends before the callbacks arrive", async () => {
  const { input, log } = watch();
  input.end();
  await log.done;
  await expect(
    log.waitFor({
      mode: "baseline",
      legacyCallbacks: true,
      workload: "pool",
      count: 1,
      from: 1000,
      run: "missing",
    }),
  ).rejects.toThrow("Log stream ended");
});

test("times out rather than starting another trial with missing callbacks", async () => {
  const { log } = watch();
  await expect(
    log.waitFor(
      {
        mode: "baseline",
        legacyCallbacks: true,
        workload: "pool",
        count: 1,
        from: 1000,
        run: "missing",
      },
      { timeoutMs: 0 },
    ),
  ).rejects.toThrow("Expected 1 callback commits for missing, observed 0");
});

test("propagates malformed logs even when no success callbacks are expected", async () => {
  const { input, log } = watch();
  input.end('{"kind":');
  await log.done;
  await expect(
    log.waitFor({
      mode: "filtered",
      workload: "pool",
      count: 1,
      from: 1000,
      run: "broken",
    }),
  ).rejects.toThrow("Invalid log JSON at test.logs.jsonl:1");
});

test.each(["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", ""])(
  "rejects --repeats=%s before connecting to a deployment",
  (repeats) => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./run.mjs", import.meta.url)),
        `--repeats=${repeats}`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "--repeats must be a positive safe integer",
    );
    expect(result.stdout).not.toContain("Target:");
  },
);

function auditFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "workpool-audit-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "results.json");
  const logsPath = path.join(directory, "results.logs.jsonl");
  const samples = [-1, 0].map((round) => ({
    mode: "baseline",
    legacyCallbacks: true,
    workload: "pool",
    maxParallelism: 25,
    round,
    count: 1,
    steps: 1,
    from: (round + 2) * 1000,
    admittedAt: (round + 2) * 1000 + 1,
    drainedAt: (round + 3) * 1000 - 1,
    admissionMs: 1,
    throughput: 10,
    elapsedMs: 100,
    run: `round-${round}`,
  }));
  writeFileSync(
    filename,
    JSON.stringify({
      repeats: 1,
      workloads: ["pool"],
      parallelisms: [25],
      modes: ["baseline"],
      samples,
    }),
  );
  const entries = samples.flatMap((s) =>
    [
      ["worker:runMutationWrapper", "poolBaseline"],
      ["complete:complete", "poolBaseline"],
      ["benchmark:ignoredSuccess", null],
      ["loop:loop", "poolBaseline/batchWorker"],
    ].map(([identifier, componentPath], index) =>
      completion(`${s.round}-${index}`, {
        identifier,
        componentPath,
        timestamp: (s.from + index + 10) / 1000,
      }),
    ),
  );
  writeFileSync(
    logsPath,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return {
    filename,
    logsPath,
    audit: () =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./summarize.mjs", import.meta.url)), filename],
        { encoding: "utf8" },
      ),
  };
}

test("audits a complete matrix including loop executions", () => {
  const { filename, audit } = auditFixture();
  const result = audit();
  expect(result.status, result.stderr).toBe(0);
  expect(
    JSON.parse(readFileSync(filename, "utf8")).summary[0]
      .medianScheduledCommits,
  ).toBe(4);
});

test.each([
  '{"kind":"Completion",INVALID}\n',
  '{"kind":"Completion","identifier":"loop:loop"',
])(
  "rejects malformed or truncated loop records despite complete callback coverage (%s)",
  (brokenLine) => {
    const { filename, logsPath, audit } = auditFixture();
    const original = readFileSync(filename, "utf8");
    appendFileSync(logsPath, brokenLine);
    const result = audit();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Invalid log JSON at ${logsPath}:9`);
    expect(readFileSync(filename, "utf8")).toBe(original);
  },
);

test.each(["baseline", "transactional", "allMutations"])(
  "audits nested and scheduled query completions for %s",
  (mode) => {
    const { filename, logsPath, audit } = auditFixture();
    const results = JSON.parse(readFileSync(filename, "utf8"));
    results.workloads = ["query"];
    results.modes = [mode];
    for (const sample of results.samples) {
      sample.workload = "query";
      sample.mode = mode;
      sample.legacyCallbacks = false;
    }
    writeFileSync(filename, JSON.stringify(results));
    const entries = results.samples.flatMap((s) => {
      const records = [];
      const add = (identifier, caller = "Scheduler") =>
        records.push(
          completion(`${s.round}-${records.length}`, {
            identifier,
            caller,
            componentPath: mode,
            timestamp: (s.from + records.length + 10) / 1000,
          }),
        );
      for (let i = 0; i < (mode === "allMutations" ? 3 : 2); i++)
        add("worker:runMutationWrapper");
      if (mode === "baseline") {
        add("complete:complete");
        add("complete:complete");
      }
      if (mode !== "allMutations") {
        add("worker:runBatch");
        add("complete:complete", "Function");
      }
      add("loop:loop");
      return records;
    });
    writeFileSync(
      logsPath,
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const result = audit();
    expect(result.status, result.stderr).toBe(0);
    const [sample] = JSON.parse(readFileSync(filename, "utf8")).samples;
    expect(sample.executions.totalCompletions).toBe(
      mode === "baseline" ? 3 : mode === "transactional" ? 1 : 0,
    );
    expect(sample.executions.scheduledSuccessCallbacks).toBe(0);
    expect(sample.executions.separateCompletions).toBe(
      mode === "baseline" ? 2 : 0,
    );
  },
);

test.each([0, 1])(
  "rejects a closed capture even with %i satisfied callbacks",
  async (count) => {
    const { input, log, emit } = watch();
    if (count) emit(completion("last"));
    input.end();
    await log.done;
    await expect(
      log.waitFor({
        mode: "baseline",
        legacyCallbacks: true,
        workload: "pool",
        count,
        from: 1000,
        run: "closed",
      }),
    ).rejects.toThrow("Log stream ended");
  },
);

test("audits allMutations actions with only handler mutation wrappers", () => {
  const { filename, logsPath, audit } = auditFixture();
  const results = JSON.parse(readFileSync(filename, "utf8"));
  results.workloads = ["action"];
  results.modes = ["allMutations"];
  for (const s of results.samples)
    Object.assign(s, {
      workload: "action",
      mode: "allMutations",
      legacyCallbacks: false,
    });
  writeFileSync(filename, JSON.stringify(results));
  const entries = results.samples.flatMap((s) =>
    [
      "worker:runMutationWrapper",
      "worker:runMutationWrapper",
      "worker:runBatch",
      "loop:loop",
    ].map((identifier, i) =>
      completion(`${s.round}-${i}`, {
        identifier,
        componentPath: "allMutations",
        timestamp: (s.from + i + 10) / 1000,
      }),
    ),
  );
  writeFileSync(
    logsPath,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  const result = audit();
  expect(result.status, result.stderr).toBe(0);
});
