# Transactional completion with current Workflow and workpool

See [RESULTS.md](RESULTS.md) for the measured comparison.

This isolated Convex app benchmarks the current Workflow checkout (0.5.0,
rebased onto main) with released workpool 0.5.0 and transactional completion
from workpool PRs [#238](https://github.com/convex/workpool/pull/238) and
[#239](https://github.com/convex/workpool/pull/239), rebased onto workpool main.
The library and example retain their released dependencies and peer ranges.

## Variants

| Mode            | Workpool       | Transactional completion                   |
| --------------- | -------------- | ------------------------------------------ |
| `baseline`      | Released 0.5.0 | Off                                        |
| `prFiltered`    | Rebased PRs    | Off                                        |
| `transactional` | Rebased PRs    | Workflow handlers                          |
| `allMutations`  | Rebased PRs    | Workflow handlers and mutation/query steps |

All modes retain current Workflow's exclusion of already-ignored handler success
callbacks. `filtered` is retained as an alias of the released baseline for older
commands, but is omitted from the default matrix. Compare `prFiltered` against
`allMutations` to isolate transactional completion within the same package, and
`baseline` against `allMutations` for the release impact. `transactional`
isolates how much comes from handlers alone.

`prepare.mjs` generates components from this checkout's actual source. It
preserves success results for steps and fails if transformation anchors change.
The `allMutations` name is retained for command compatibility; it now enables
both mutation and query step completion. Actions remain nontransactional. See
[vendor/README.md](vendor/README.md) for the exact rebased workpool source,
patch, packaged artifact, and reproduction instructions.

## Run

Use Node 22+ and install dependencies at the repository root with `npm ci`. The
benchmark has its own `convex.json`; use a dedicated development deployment. For
example, from the repository root (replace `<team>` and `<project>`):

```sh
npx convex deployment create "<team>:<project>:dev/workpool-benchmark" --type dev --expiration 'in 7 days'
npx convex deployment token create workpool-benchmark --deployment <new-deployment-name> --save-env experiments/workpool/.env.local
npm run bench:workpool:push
npm run bench:workpool -- --repeats=3 --parallelism=25,100 --workloads=mutation,query --flows=100 --steps=5
node experiments/workpool/summarize.mjs experiments/workpool/results.local.json
```

`bench:workpool:push` generates and deploys the app, then typechecks the app and
all generated source. Its local `node_modules` symlink reuses root dependencies.
`convex.mjs` preserves the root Node executable when changing directories.
Tokens and generated code are gitignored.

Runner options use `--name=value` syntax. `--repeats` must be a positive safe
integer (default: 3). `--workloads=pool,mutation,query,action,inline` selects
workloads; the default is `mutation,query`. `--modes=baseline,transactional`
selects a subset. `--output=path.json` selects the result artifact. Matching
`path.logs.jsonl` contains the raw Convex execution stream.

## Measurement and validation

Trials run sequentially on the same deployment. Each selected workload, mode,
and parallelism combination gets a 10-item warm-up before `--repeats` measured
rounds (default: three). The direct-pool workload skips `allMutations` entirely,
since it is identical to `transactional` for direct jobs. Warm-ups use 10 direct
jobs or 10 workflows with the configured number of steps. Round order rotates
and reverses to reduce ordering bias. Every trial waits for its workpool to
empty and become idle, then waits for the expected success callback commits in
the execution-log stream before recording `drainedAt` and starting the next
trial. This includes callbacks in the app, which can outlive the pool's work
records. The callbacks remain no-ops; the wait adds no marker writes to the
measured workload.

- Direct pool jobs use a single batch enqueue, each writing an independent
  completion row. The success callback returns immediately when called.
- By default, measured workflow trials asynchronously start 100 independent
  workflows, each awaiting five steps in sequence (`--flows` and `--steps`
  override these counts). Mutation steps insert independent rows. Query steps
  read a seeded row per workflow. Both return numbers used in the workflow's
  final sum; queries are verified to produce no step writes. No shared counters
  create artificial contention. The `inline` workload runs those steps inline;
  `action` wraps the same write in an action.
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
  direct-pool failure, cancellation, and mutation-write rollback for the
  selected `baseline`, `filtered`, `prFiltered`, and `transactional` modes.
  These are direct-job preflights, not workflow-step failure tests.
  `allMutations` has no separate preflight; its successful workflow results and
  step writes are checked, but transactional step-callback failure and rollback
  are not covered.
- The summarizer rejects incomplete trial matrices, verifies the expected
  wrapper and separate completion counts against logs, fails on malformed JSONL
  records (including truncated lines) and runtime errors, and reports scheduled
  executions, per-function execution time, and OCC retries. Scheduled execution
  counts include workpool loop overhead; they exclude the benchmark driver's
  actions/queries. They are not a count of all nested UDF calls or a billing
  estimate.

Percentage comparisons are ratios of the medians. The ranges across measured
rounds are descriptive, not confidence intervals.

These are finite-batch, cheap-write synthetic workloads on a development
deployment. They measure scheduling overhead under this load, not production
capacity or application workloads with expensive I/O. Shared-cloud variation,
admission cost, callback writes, and larger transactions can affect the result.
Transactional mutation-step completion also changes rollback semantics: a
success callback failure rolls back the step's writes. Transactional query reads
use independent snapshots and may be stale when completion commits. Successful
throughput tests do not establish full migration or failure-recovery
compatibility.

## Earlier experiment

[historical/RESULTS.md](historical/RESULTS.md) and its adjacent JSON retain the
previous measurements against released workpool 0.4.7 and PR commit `14eabf7`.
The September 0.4.12 comparison is retained in
[historical/RESULTS-september-0.4.12.md](historical/RESULTS-september-0.4.12.md).
Versions and mode meanings differ; do not combine those results with this run.
