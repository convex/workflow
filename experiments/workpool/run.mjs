import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const cwd = fileURLToPath(new URL("./", import.meta.url));
const cliPath = path.join(cwd, "../../node_modules/convex/bin/main.js");
const flags = Object.fromEntries(
  process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")),
);
const repeats = Number(flags.repeats ?? 3);
const parallelisms = (flags.parallelism ?? "25,100").split(",").map(Number);
const workloads = (flags.workloads ?? "pool,mutation").split(",");
const modes = (
  flags.modes ?? "baseline,filtered,prFiltered,transactional,allMutations"
).split(",");
const prefix = new Date().toISOString().replaceAll(/[:.]/g, "-");
const output = path.resolve(
  flags.output ?? path.join(cwd, "results.local.json"),
);
const samples = [];
const results = {
  date: new Date().toISOString(),
  node: process.version,
  repeats,
  parallelisms,
  workloads,
  modes,
  samples,
};
const lock = JSON.parse(
  readFileSync(path.join(cwd, "../../package-lock.json"), "utf8"),
);
results.packages = Object.fromEntries(
  ["convex", "@convex-dev/workpool", "@convex-dev/workpool-transactional"].map(
    (name) => {
      const { version, resolved, integrity } =
        lock.packages[`node_modules/${name}`];
      return [name, { version, resolved, integrity }];
    },
  ),
);

async function cli(args) {
  const result = await promisify(execFile)(
    process.execPath,
    [cliPath, ...args],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}
function run(name, args) {
  return cli(["run", `benchmark:${name}`, JSON.stringify(args)]);
}
function save() {
  writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Read only the URL for metadata; never serialize the deployment token.
const env = readFileSync(path.join(cwd, ".env.local"), "utf8");
results.deployment = env.match(/^CONVEX_URL=(.+)$/m)?.[1];
assert(results.deployment, "Set up the isolated benchmark deployment first");
console.log(`Target: ${results.deployment}`);
const logsPath = output.replace(/\.json$/, "") + ".logs.jsonl";
const logsFile = createWriteStream(logsPath);
const logs = spawn(process.execPath, [cliPath, "logs", "--jsonl"], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
});
logs.stdout.pipe(logsFile);
logs.stderr.on("data", (data) => {
  // The CLI can print stream connection information on stderr.
  if (data.toString().includes("Error")) process.stderr.write(data);
});

async function drain(component) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const idle = await cli([
      "run",
      "--component",
      component,
      "--inline-query",
      'return (await ctx.db.query("work").take(1)).length === 0;',
    ]);
    if (idle) {
      const workerIdle = await cli([
        "run",
        "--component",
        `${component}/batchWorker`,
        "--inline-query",
        'return (await ctx.db.query("workers").collect()).every(w => w.status.kind === "idle");',
      ]);
      if (workerIdle) return;
    }
    await sleep(500);
  }
  throw new Error(`Pool did not drain: ${component}`);
}

try {
  for (const mode of modes.filter((m) => m !== "allMutations")) {
    const id = `${prefix}-check-${mode}`;
    await run("startFailureChecks", { mode, run: id });
    await drain(
      ["baseline", "filtered"].includes(mode) ? "poolBaseline" : "poolPr",
    );
    const observed = await run("observe", { run: id });
    assert.deepEqual(observed.map((r) => [r.index, r.kind]).sort(), [
      [0, "failed"],
      [1, "canceled"],
    ]);
    console.log(`Failure / cancellation / rollback checks passed: ${mode}`);
  }
  for (const workload of workloads) {
    const selected = modes.filter(
      (m) => workload !== "pool" || m !== "allMutations",
    );
    for (const maxParallelism of parallelisms) {
      // Warm each variant, then rotate and reverse trial order between rounds.
      for (let round = -1; round < repeats; round++) {
        const offset = Math.max(round, 0) % selected.length;
        const order = [...selected.slice(offset), ...selected.slice(0, offset)];
        if (round % 2 === 1) order.reverse();
        for (const mode of order) {
          const args = {
            mode,
            workload,
            maxParallelism,
            count:
              round === -1
                ? 10
                : Number(
                    workload === "pool"
                      ? (flags.jobs ?? 500)
                      : (flags.flows ?? 100),
                  ),
            steps: workload === "pool" ? 1 : Number(flags.steps ?? 5),
            run: `${prefix}-${workload}-${maxParallelism}-${round}-${mode}`,
          };
          console.log(
            `Running ${workload} ${mode} parallelism=${maxParallelism} round=${round} count=${args.count}`,
          );
          const from = Date.now();
          const measured = await run("run", args);
          const to = Date.now();
          await drain(
            workload === "pool"
              ? ["baseline", "filtered"].includes(mode)
                ? "poolBaseline"
                : "poolPr"
              : `${mode}/workpool`,
          );
          samples.push({
            ...args,
            round,
            from,
            to,
            drainedAt: Date.now(),
            ...measured,
          });
          save();
          console.log(
            `  ${measured.elapsedMs} ms, ${measured.throughput.toFixed(1)} ${workload === "pool" ? "jobs" : "steps"}/s (verified and drained)`,
          );
        }
      }
    }
  }
} finally {
  save();
  await sleep(2000);
  const closed = new Promise((resolve) => logs.once("close", resolve));
  logs.kill("SIGTERM");
  await closed;
}
console.log(`Saved ${samples.length} samples to ${output}`);
