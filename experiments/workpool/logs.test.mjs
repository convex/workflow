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
