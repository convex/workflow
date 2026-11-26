// The model shared by proptest.test.ts and
// restart.property.test.ts. `evaluate` says what running an `Op` (see
// proptest.ts) should return and which side-effect rows it should leave.

import type { Op } from "./proptest";

export type Outcome = { ok: true; value: unknown } | { ok: false };

export type Expected = {
  // Rows each key already has from an earlier run (before a restart).
  prior?: Map<string, number>;
  // Per key: how many rows of this kind the step functions should commit.
  // `exact: false` means at most `count`.
  effects: Map<
    string,
    { kind: "mutation" | "attempt"; count: number; exact: boolean }
  >;
};

export function evaluate(op: Op, exp: Expected): Outcome {
  switch (op.kind) {
    case "query":
      return { ok: true, value: op.value };
    case "mutation":
      exp.effects.set(op.key, {
        kind: "mutation",
        count: (exp.prior?.get(op.key) ?? 0) + (op.fail ? 0 : 1),
        exact: true,
      });
      return op.fail ? { ok: false } : { ok: true, value: op.key };
    case "action": {
      // `flaky` numbers attempts across runs, so after a restart the first
      // `prior` attempts have already been used up.
      const prior = exp.prior?.get(op.key) ?? 0;
      const failsLeft = Math.max(op.failTimes - prior, 0);
      const attempts = Math.min(failsLeft + 1, op.maxAttempts);
      exp.effects.set(op.key, {
        kind: "attempt",
        count: prior + attempts,
        exact: true,
      });
      return failsLeft < op.maxAttempts
        ? { ok: true, value: op.key }
        : { ok: false };
    }
    case "sleep":
      return { ok: true, value: null };
    case "parallel": {
      const before = new Set(exp.effects.keys());
      const outcomes = op.ops.map((o) => evaluate(o, exp));
      if (outcomes.every((o) => o.ok)) {
        return {
          ok: true,
          value: outcomes.map((o) => (o as { value: unknown }).value),
        };
      }
      // Promise.all rejected. The other branches carry on in the background
      // and may or may not finish, so their counts become upper bounds.
      for (const [key, e] of exp.effects) {
        if (!before.has(key)) e.exact = false;
      }
      return { ok: false };
    }
    case "try": {
      const inner = evaluate(op.op, exp);
      return {
        ok: true,
        value: inner.ok ? { ok: inner.value } : { caught: true },
      };
    }
    case "child":
      return evaluateList(op.ops, exp);
    case "extWait":
      return op.error ? { ok: false } : { ok: true, value: op.key };
    case "big":
      // Results over MAX_RETURN_VALUE_SIZE (800 KiB, oversizedValues.ts)
      // fail the step.
      return op.kb * 1024 > 800 << 10
        ? { ok: false }
        : { ok: true, value: op.kb * 1024 };
    case "throw":
      return { ok: false };
    case "event":
      if (!op.send) return { ok: true, value: { kind: "timeout" } };
      return {
        ok: true,
        value:
          op.timeout === undefined ? op.key : { kind: "event", value: op.key },
      };
  }
}

// Runs ops in order and stops at the first failure, as `runOps` does. Ops
// after a failure never start, so they are left out of `effects` and must
// have no rows.
export function evaluateList(ops: Op[], exp: Expected): Outcome {
  const results: unknown[] = [];
  for (const op of ops) {
    const outcome = evaluate(op, exp);
    if (!outcome.ok) return outcome;
    results.push(outcome.value);
  }
  return { ok: true, value: results };
}
