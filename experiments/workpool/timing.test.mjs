import { afterEach, expect, test, vi } from "vitest";
import { admit, executionDuration } from "./convex/lib/timing.ts";

afterEach(() => vi.restoreAllMocks());

test("uses admission time when work finishes before the response arrives", async () => {
  let now = 900;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const admitted = await admit(async () => {
    now = 2000;
    return { ids: ["work"], startedAt: 1000 };
  });
  expect(admitted).toEqual({
    ids: ["work"],
    startedAt: 1000,
    admittedAt: 1000,
  });
  expect(executionDuration(admitted.admittedAt, 1010)).toBe(10);
  expect(() => executionDuration(Date.now(), 1010)).toThrow(
    "below timestamp resolution",
  );
});

test("rejects durations below timestamp resolution", () => {
  expect(() => executionDuration(1000, 1000)).toThrow(
    "below timestamp resolution",
  );
});
