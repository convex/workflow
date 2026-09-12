# Workpool 0.4.12: callback exclusion and transactional completion

Excluding ignored handler success callbacks removes **600 scheduled callbacks**
from a batch of 100 workflows with five mutation steps each, reducing total
scheduled executions by **17.5–18.1%**. It did **not** produce a consistent
throughput improvement in this run: median throughput changed by **−20.7% at
parallelism 25** and **+9.6% at parallelism 100**. Including admission, the
latter gain was **6.6%**. The exclusion trials had wide ranges; these are
descriptive measurements from three trials per configuration, not precise
estimates of a universal speedup or regression.

Transactional completion of handlers alone also did not demonstrate a workflow
throughput gain against the PR package with transactions disabled: **essentially
unchanged at 25** and **−7.4% at 100**. Completing mutation steps
transactionally as well was more promising at 100: **+15.4% versus the PR
control**, or **+18.0% versus released 0.4.12 with success excluded**, with
substantial variation. At 25 it was **5.1% slower than the PR control**.

The dependable result is the reduction in scheduled executions. These timings do
not establish that enabling transactional completion for just the eligible
handlers will increase throughput.

## Scope and versions

- Base change:
  [workflow PR #283](https://github.com/get-convex/workflow/pull/283). Only
  async start, async restart, and handler resume exclude success. Their
  `handlerOnComplete` callback already returns immediately on success. Failure
  and cancellation callbacks remain enabled; ordinary step results are retained.
- Experiment:
  [workflow PR #284](https://github.com/get-convex/workflow/pull/284), stacked
  on #283. Five generated components use the same workflow source.
- Released control and exclusion treatment both use **workpool 0.4.12**.
- Transactional package:
  [workpool PR #238](https://github.com/get-convex/workpool/pull/238) at
  **`bec8e660f8fd0b54d4783ad737159eccb268a4ca`**, installed as
  `@convex-dev/workpool-transactional`. Its tarball still declares version
  `0.4.11`; the commit and integrity identify the tested implementation.
- Both packages use batch-worker **0.2.2**. Convex SDK **1.43.0**, Node
  **22.22.2**.
- Source: base commit `df72483`; timing harness commit `3004f5e`. Subsequent
  changes add reporting and log analysis without changing the timed functions.
- Run began **2026-09-12 02:42 UTC** on the isolated development deployment
  `aware-mandrill-795`. No production deployment was changed.

## Workflow throughput

Each trial starts 100 workflows asynchronously, each awaiting five sequential
mutation steps. Each step writes an independent row and returns a number used in
the workflow's final result. All 500 writes and all 100 results are checked.

Rates are **committed steps/second**, excluding admission and idle-loop
settling, measured through the last work/completion/callback commit in execution
logs. Cells show **median (minimum–maximum)** across three measured trials.
Every configuration has a separate warm-up; trial order rotates and reverses.

| Mode                                   |   Parallelism 25 |  Parallelism 100 |
| -------------------------------------- | ---------------: | ---------------: |
| 0.4.12, callbacks enabled              | 15.8 (15.7–16.0) | 25.4 (25.0–25.5) |
| 0.4.12, success excluded               | 12.6 (11.3–16.2) | 27.8 (16.2–30.9) |
| PR, success excluded, transactions off | 16.8 (16.0–16.9) | 28.4 (23.6–30.6) |
| PR, transactional handlers             | 16.8 (15.1–18.1) | 26.3 (25.6–32.8) |
| PR, transactional handlers and steps   | 15.9 (14.7–19.4) | 32.8 (23.0–35.4) |

The first two rows isolate callback exclusion on released 0.4.12. The third and
fourth isolate the transactional handler option within the same PR package.
Comparing released exclusion directly with transactional handlers would suggest
**+33.5% at 25**, but the PR control is just as fast there; that difference
cannot be attributed to the transactional option.

Admission matters: at 100, the released control and exclusion treatment deliver
**21.0 and 22.4 steps/s including enqueue time**, respectively (+6.6%). Median
admission times are 3.9 and 4.3 seconds. The complete admission and end-to-end
measurements are retained in the JSON artifact.

The generated released components differ only at the three exclusion options. In
the two slower exclusion trials at 25, mean wrapper execution time rose from 102
ms in round 0 to 142 and 147 ms, while mean user-code execution time stayed
around 2.0–2.2 ms. Completion and loop execution times rose too, without retries
or additional work executions. This describes where time increased; it does not
identify the cause. The ranges and differences between controls warrant caution
about attributing all timing changes to the options.

## Direct pool throughput

Each trial batch-enqueues 500 independent mutations. Each writes a completion
row; the attached success callback returns immediately when called. Rates below
include the completion tail, in **committed jobs/second**.

| Mode                                   |   Parallelism 25 |   Parallelism 100 |
| -------------------------------------- | ---------------: | ----------------: |
| 0.4.12, callbacks enabled              | 41.4 (35.7–45.9) |  75.5 (72.5–85.6) |
| 0.4.12, success excluded               | 41.7 (33.0–42.2) | 74.0 (53.8–101.6) |
| PR, success excluded, transactions off | 37.8 (32.7–40.3) |  87.2 (70.6–87.5) |
| PR, transactional jobs                 | 44.6 (36.2–47.9) |  87.1 (66.4–91.6) |

Exclusion alone changes direct throughput by **+0.6% / −2.0%** at 25/100, while
removing 500 callbacks and reducing scheduled executions by **32.2–32.9%**.
Within the PR package, transactionality changes throughput by **+18.2% /
−0.1%**. The `allMutations` mode would be identical to `transactional` for this
workload, so it is not run twice.

## Scheduled executions

Median successful scheduler-initiated executions per 100-workflow, 500-step
trial, including workpool loops:

| Mode                                   | Parallelism 25 | Parallelism 100 |
| -------------------------------------- | -------------: | --------------: |
| 0.4.12, callbacks enabled              |          3,412 |           3,334 |
| 0.4.12, success excluded               |          2,815 |           2,731 |
| PR, success excluded, transactions off |          2,813 |           2,734 |
| PR, transactional handlers             |          2,205 |           2,134 |
| PR, transactional handlers and steps   |          1,202 |           1,135 |

Exclusion removes six ignored success callbacks per workflow: the async start
and five resumes. Transactional handlers additionally remove 600 separate
completion mutations. Transactional steps remove another 500 completion
mutations and run the 500 necessary step callbacks inline; their successful
results are still consumed.

These counts exclude the benchmark driver and its queries. Nested UDF calls
still run inside transactions, so these are neither total function-call counts
nor a billing estimate. Timing savings need not track execution-count savings.

## Validation and reproduction

All **72 trials** passed: **54 measured trials and 18 warm-ups**. Checks include
exact completion counts, unique indices, final workflow status and summed
results, missing/duplicate step writes, and drained queues between trials. All
eight preflight failed/canceled jobs produced the expected callbacks; failed
mutation writes rolled back and canceled jobs did not execute.

The log audit verifies the complete trial matrix and exact wrapper, separate
completion, and ignored-success callback counts. There were **no measured
retries or runtime errors**. One PR-control warm-up had nine OCC retries, which
are retained in the artifact and excluded from measured medians.

The library build, root/example typechecks, isolated deployment, and benchmark
typecheck pass. **129 tests pass**, including six new cases covering success
exclusion and handler failure propagation through start, restart, and resume.
Lint passes with three existing warnings.

```sh
npm ci
npm run bench:workpool:push
npm run bench:workpool -- --repeats=3 --parallelism=25,100 --jobs=500 --flows=100 --steps=5 --output=experiments/workpool/results.json
node experiments/workpool/summarize.mjs experiments/workpool/results.json
```

See [README.md](README.md) for dedicated deployment setup and all runner
options. [results.json](results.json) contains every sample, package
integrities, per-function counts/timings, summaries, and percentage comparisons.
Raw execution logs remain in the ignored local `results.logs.jsonl` file. The
[historical report](historical/RESULTS.md) preserves the earlier 0.4.7
experiment; it uses different package versions and modes and should not be
combined with these results.

These are finite batches of inexpensive writes on a development deployment.
Restart, cleanup, cancellation races, callback-failure recovery, and transaction
limits are not throughput-tested. Transactional step completion changes rollback
semantics when a success callback fails; successful throughput tests do not
establish full migration or failure-recovery compatibility.
