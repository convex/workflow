import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

export async function* readLogs(input, source) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (cause) {
      throw new Error(`Invalid log JSON at ${source}:${lineNumber}`, { cause });
    }
    yield entry;
  }
}

export function expectedSuccessCallbacks(sample) {
  return sample.mode === "baseline"
    ? sample.count *
        (sample.workload === "pool" || sample.workload === "inline"
          ? 1
          : sample.steps + 1)
    : 0;
}

// Pool idleness does not imply that its separately scheduled callbacks have
// committed. Observe their completion logs without adding writes to the no-op
// callbacks being benchmarked. Only one trial runs at a time on this deployment.
export class CallbackLog {
  commits = new Map();
  error;
  ended = false;

  constructor(input, source) {
    this.done = this.consume(input, source)
      .catch((error) => {
        this.error = error;
      })
      .finally(() => {
        this.ended = true;
      });
  }

  async consume(input, source) {
    for await (const entry of readLogs(input, source)) {
      if (
        entry.kind !== "Completion" ||
        entry.caller !== "Scheduler" ||
        entry.error ||
        entry.willRetry ||
        !["benchmark:ignoredSuccess", "pool:handlerOnComplete"].includes(
          entry.identifier,
        )
      )
        continue;
      this.commits.set(`${entry.executionId}/${entry.timestamp}`, {
        at: entry.timestamp * 1000,
        component: entry.componentPath ?? "",
        identifier: entry.identifier,
      });
    }
  }

  async waitFor(sample, { timeoutMs = 60_000 } = {}) {
    const expected = expectedSuccessCallbacks(sample);
    const component = sample.workload === "pool" ? "" : sample.mode;
    const identifier =
      sample.workload === "pool"
        ? "benchmark:ignoredSuccess"
        : "pool:handlerOnComplete";
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error("Log stream ended before trial drain");
      const observed = [...this.commits.values()].filter(
        (entry) =>
          entry.at >= sample.from &&
          entry.component === component &&
          entry.identifier === identifier,
      ).length;
      if (observed === expected) return;
      if (observed > expected || Date.now() >= deadline) {
        throw new Error(
          `Expected ${expected} callback commits for ${sample.run}, observed ${observed}`,
        );
      }
      await sleep(50);
    }
  }
}
