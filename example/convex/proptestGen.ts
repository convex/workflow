// fast-check generators for the `Op` lists that `runOps` in proptest.ts
// runs. Shared by proptest.test.ts and cancel.property.test.ts.

import fc from "fast-check";
import type { Op } from "./proptest";

/**
 * Generates ops with an empty `key`; `assignKeys` fills them in afterwards so
 * every mutation, action and event in a run has its own key.
 *
 * With `hang`, it also generates untimed waits that nothing sends to. Those
 * never end on their own, so only tests that cancel the workflow use them.
 * With `ext`, it also generates `big` and `extWait` ops; tests that use
 * `extWait` must send its event (see `extWaits` in proptest.test.ts).
 * `width` caps each op list and `depth` sets how deep the ops nest.
 */
export function opArb(opts: {
  hang: boolean;
  ext?: boolean;
  width?: number;
  depth?: fc.DepthSize;
}): fc.Arbitrary<Op> {
  const events: fc.Arbitrary<Op>[] = [
    fc.record({
      kind: fc.constant("event" as const),
      key: fc.constant(""),
      send: fc.constant(true),
      timeout: fc.option(fc.integer({ min: 1000, max: 5000 }), {
        nil: undefined,
      }),
    }),
    fc.record({
      kind: fc.constant("event" as const),
      key: fc.constant(""),
      send: fc.constant(false),
      timeout: fc.integer({ min: 1000, max: 5000 }),
    }),
  ];
  if (opts.hang) {
    events.push(
      fc.record({
        kind: fc.constant("event" as const),
        key: fc.constant(""),
        send: fc.constant(false),
      }),
    );
  }
  const ext: fc.Arbitrary<Op>[] = opts.ext
    ? [
        fc.record({
          kind: fc.constant("big" as const),
          // Either side of the 800 KiB limit, kept rare so the journal stays
          // under its 8 MiB limit.
          kb: fc.constantFrom(1, 400, 790, 810, 1000),
          inline: fc.boolean(),
        }),
        fc
          .record({
            kind: fc.constant("extWait" as const),
            key: fc.constant(""),
            byId: fc.boolean(),
            // Sent with an error about one time in four.
            error: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
            early: fc.boolean(),
          })
          // A wait by ID has no ID to send to until its event is created.
          .map((op) => ({ ...op, early: op.early && !op.byId })),
      ]
    : [];
  return fc.letrec<{ op: Op; ops: Op[] }>((tie) => ({
    op: fc.oneof(
      { depthSize: opts.depth ?? "small", withCrossShrink: true },
      fc.record({
        kind: fc.constant("query" as const),
        value: fc.integer({ min: 0, max: 100 }),
        inline: fc.boolean(),
      }),
      fc.record({
        kind: fc.constant("mutation" as const),
        key: fc.constant(""),
        inline: fc.boolean(),
        // Fails about one time in four.
        fail: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
      }),
      fc.record({
        kind: fc.constant("action" as const),
        key: fc.constant(""),
        failTimes: fc.integer({ min: 0, max: 3 }),
        maxAttempts: fc.integer({ min: 1, max: 4 }),
      }),
      fc.record({
        kind: fc.constant("sleep" as const),
        ms: fc.integer({ min: 0, max: 5000 }),
      }),
      fc.oneof(...events),
      // A handler error with no step, from proptest.ts.
      fc.constant({ kind: "throw" as const }),
      ...ext,
      fc.record({ kind: fc.constant("parallel" as const), ops: tie("ops") }),
      fc.record({ kind: fc.constant("try" as const), op: tie("op") }),
      fc.record({ kind: fc.constant("child" as const), ops: tie("ops") }),
    ),
    ops: fc.array(tie("op"), { minLength: 1, maxLength: opts.width ?? 3 }),
  })).op;
}

export function assignKeys(ops: Op[], next = { n: 0 }): Op[] {
  return ops.map((op): Op => {
    switch (op.kind) {
      case "mutation":
      case "action":
      case "event":
      case "extWait":
        return { ...op, key: `k${next.n++}` };
      case "parallel":
      case "child":
        return { ...op, ops: assignKeys(op.ops, next) };
      case "try":
        return { ...op, op: assignKeys([op.op], next)[0] };
      default:
        return op;
    }
  });
}
