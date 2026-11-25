import { afterEach, expect, test, vi } from "vitest";
import { run } from "./convex/benchmark.ts";

afterEach(() => vi.restoreAllMocks());

test.each([1010, 1000])(
  "handles completion at %i before the start response reaches the action",
  async (at) => {
    let now = 900;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const ctx = {
      runMutation: async () => {
        now = 2000; // Work already finished while the response was in transit.
        return { ids: ["work"], startedAt: 1000 };
      },
      runQuery: vi
        .fn()
        .mockResolvedValueOnce([{ index: 0, kind: "executed", at }])
        .mockResolvedValueOnce(true),
    };
    const result = run._handler(ctx, {
      mode: "baseline",
      workload: "pool",
      count: 1,
      steps: 1,
      maxParallelism: 25,
      run: "race",
    });
    if (at === 1000)
      await expect(result).rejects.toThrow("below timestamp resolution");
    else
      await expect(result).resolves.toMatchObject({
        admittedAt: 1000,
        admissionMs: 100,
        executionMs: 10,
        throughput: 100,
      });
  },
);
