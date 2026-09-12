# Workpool callback exclusion and transactional completion experiment

See [RESULTS.md](RESULTS.md) for the measured comparison.

This is an isolated Convex app for benchmarking this checkout's actual workflow
implementation against workpool
[PR #238](https://github.com/get-convex/workpool/pull/238). The library and
example app continue using the released `@convex-dev/workpool` dependency. The
experimental package is installed as `@convex-dev/workpool-transactional`,
pinned to the measured PR commit `bec8e66`. The lockfile records its tarball
integrity.

## Variants

| Mode            | Workpool             | Handler success callback | Transactional completion             |
| --------------- | -------------------- | ------------------------ | ------------------------------------ |
| `baseline`      | Released 0.4.12      | Called, then ignored     | Off                                  |
| `filtered`      | Released 0.4.12      | Excluded                 | Off                                  |
| `prFiltered`    | PR #238 at `bec8e66` | Excluded                 | Off                                  |
| `transactional` | PR #238 at `bec8e66` | Excluded                 | Workflow handlers                    |
| `allMutations`  | PR #238 at `bec8e66` | Excluded                 | Workflow handlers and mutation steps |

Compare `baseline` with `filtered` to isolate success callback exclusion on the
same released package. Compare `prFiltered` with `transactional` to isolate
transactional handler completion within the PR package. `filtered` vs.
`transactional` measures the combined effect of switching packages and enabling
transactions. The PR tarball still declares version 0.4.11; its commit and
integrity identify the actual code. Both packages use batch-worker 0.2.2.

The base PR already sets `onCompleteExcludeKinds: ["success"]` for async
workflow start, async restart, and handler resume, where success is already
ignored. `prepare.mjs` copies `src/` into ignored `generated/` directories and:

- Removes those three exclusion options only for `baseline`.
- Keeps `filtered` on the released package with no source changes.
- Switches the workpool component and client imports for the three PR variants.
- Adds `completeTransactionally: true` at those sites for the transactional
  variants.
- Also enables transactional completion in the journal's `enqueueMutation` case
  for `allMutations`, preserving its success callback and result.

Query/action callbacks are retained. Cleanup and retry/restart throughput are
not benchmarked. The workflow tests exercise async start and repeated resume. No
generated fork is checked in; transforms fail if their source anchors change.

## Run

Use Node 22+ and install dependencies at the repository root with `npm ci`. The
benchmark has its own `convex.json`; use a dedicated development deployment. For
example, from the repository root:

```sh
npx convex deployment create dev/workpool-benchmark --type dev --expiration 'in 7 days'
npx convex deployment token create workpool-benchmark --deployment <new-deployment-name> --save-env experiments/workpool/.env.local
npm run bench:workpool:push
npm run bench:workpool -- --repeats=3 --parallelism=25,100 --jobs=500 --flows=100 --steps=5
node experiments/workpool/summarize.mjs experiments/workpool/results.local.json
```

`bench:workpool:push` generates and deploys the app, then typechecks the app and
all generated source. Its local `node_modules` symlink reuses root dependencies.
`convex.mjs` preserves the root Node executable when changing directories.
Tokens and generated code are gitignored.

Runner options use `--name=value` syntax.
`--workloads=pool,mutation,action,inline` selects workloads; the default is
`pool,mutation`. `--modes=baseline,transactional` selects a subset.
`--output=path.json` selects the result artifact. Matching `path.logs.jsonl`
contains the raw Convex execution stream.

## Measurement and validation

Trials run sequentially on the same deployment. Each mode gets a warm-up before
three measured rounds. Round order rotates and reverses to reduce ordering bias.
Every trial waits for its workpool to empty and become idle before the next one.

- Direct pool jobs use a single batch enqueue, each writing an independent
  completion row. The success callback returns immediately when called.
- Workflow trials asynchronously start 100 independent workflows, each awaiting
  five mutation steps in sequence. Every step inserts an independent row and
  returns a number used in the workflow's final sum. No shared counters create
  artificial contention. The `inline` workload runs those steps inline; `action`
  wraps the same write in an action.
- `admissionMs` measures the enqueue/start call separately. `executionMs` runs
  from that call returning in the server action to the final completion-row
  timestamp. `elapsedMs` includes admission from the successful start mutation's
  timestamp. `p50Ms`/`p95Ms` are batch latencies including admission, not
  individual mutation service times. Polling happens every 500 ms and is outside
  these server-timestamp measurements.
- The summarizer also calculates `committedExecutionMs` and
  `committedThroughput` from the last successful work/completion/callback
  transaction in execution logs, excluding idle-loop settling. This includes the
  completion tail that completion-row timestamps alone can miss.
- The runner checks exact completion counts, unique item indices, final workflow
  status/result, and missing or duplicate step writes. Before timing, it tests
  actual scheduled failure, cancellation, and mutation-write rollback.
- The summarizer rejects incomplete trial matrices, verifies the expected
  wrapper and separate completion counts against logs, fails on runtime errors,
  and reports scheduled executions, per-function execution time, and OCC
  retries. Scheduled execution counts include workpool loop overhead; they
  exclude the benchmark driver's actions/queries. They are not a count of all
  nested UDF calls or a billing estimate.

Percentage comparisons are ratios of the medians. The ranges across three trials
are descriptive, not confidence intervals.

These are finite-batch, cheap-write synthetic workloads on a development
deployment. They measure scheduling overhead under this load, not production
capacity or application workloads with expensive I/O. Shared-cloud variation,
admission cost, callback writes, and larger transactions can affect the result.
Transactional mutation-step completion also changes rollback semantics: a
success callback failure rolls back the step's writes. Successful throughput
tests do not establish full migration or failure-recovery compatibility.

## Earlier experiment

[historical/RESULTS.md](historical/RESULTS.md) and its adjacent JSON retain the
previous measurements against released workpool 0.4.7 and PR commit `14eabf7`.
Their API and mode meanings differ from this experiment. They are historical
observations, not the results of the current harness or evidence for the
isolated effect of exclusion on 0.4.12.
