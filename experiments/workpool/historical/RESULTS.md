> Historical run: released 0.4.7 vs. PR `14eabf7`, using the former API and modes.
> See [the current results](../RESULTS.md) for the 0.4.12 exclusion comparison.

# Workpool PR #238: measured results

Transactional completion substantially reduces scheduled executions. Its
throughput benefit depends on concurrency: **at parallelism 100, completing
workflow handlers and mutation steps transactionally improved execution
throughput by 23%, but only 7% including workflow admission**. At the default
parallelism 25, execution throughput was flat and throughput including admission
was slightly lower.

The narrower change—transactional workflow handlers, filtering their ignored
success callbacks—improved execution throughput by about 8% at parallelism 100
and about 2% including admission. Ordinary mutation-step success callbacks must
remain enabled: they record the result and resume the workflow.

## Setup

- Workflow source: `3cb2970a9c8597843f5f98952bfae9e95b84fe09` from this
  checkout.
- Baseline: `@convex-dev/workpool@0.4.7`, the repository's pinned dependency.
- Experiment:
  [workpool PR #238](https://github.com/get-convex/workpool/pull/238), commit
  `14eabf7`, package version `0.4.11`. The alias was initially installed from
  `@238`; the commit-addressed tarball was verified to have the identical
  SHA-512 integrity and is now pinned in `package.json` and the lockfile.
- Convex `1.43.0`; Node `22.22.2`; isolated development deployment
  [aware-mandrill-795](https://dashboard.convex.dev/d/aware-mandrill-795),
  created with a seven-day expiration. Separate component instances for each
  workflow variant; separate released and PR components for direct workpool
  tests.
- Started 2026-09-10T06:52:34.394Z; last trial drained
  2026-09-10T07:13:49.524000+00:00.
- Three measured trials per condition, plus one warm-up. Trials ran sequentially
  with rotated/reversed variant order and waited for each pool to drain. **54
  measured trials + 18 warm-ups**; 12,000 direct jobs and 3,000 five-step
  workflows (15,000 steps) in measured trials.

The PR includes other changes beyond these options, so the PR-default control is
necessary. Its behavior and performance are not interchangeable with version
0.4.7.

## Workflow throughput

Each trial starts 100 workflows asynchronously, each awaiting five mutation
steps. Each step writes an independent document and returns a value checked in
the final sum. No shared counters are updated. Values are **median steps/second
(min–max)**. Execution throughput excludes admission and includes the final
work, completion, or callback transaction, measured from execution logs.

| Variant                            |   Parallelism 25 |  Parallelism 100 |
| ---------------------------------- | ---------------: | ---------------: |
| Current workpool 0.4.7             | 21.4 (15.4–21.8) | 34.6 (33.4–35.0) |
| PR, default options                | 17.6 (16.9–18.0) | 34.2 (33.5–36.0) |
| PR, filter handler successes       | 17.8 (16.3–19.3) | 35.3 (35.0–37.1) |
| PR, transactional handlers         | 20.6 (18.0–21.5) | 37.2 (36.3–38.2) |
| PR, transactional handlers + steps | 21.4 (21.4–21.9) | 42.6 (36.3–43.8) |

The baseline's parallelism-25 range is wide; these three samples do not support
a reliable throughput improvement at that setting. At parallelism 100, the
strongest variant's execution range was above the baseline range, but these are
development cloud observations rather than a production capacity guarantee.

### Including admission

Admission is the server action's workflow start/enqueue call. It was roughly 3.0
seconds for the baseline and 3.4–4.3 seconds for PR workflow variants, depending
on the condition. This reduces the end-to-end gain for this finite-batch
workload. Median throughput below includes admission plus all work/completion
transactions.

| Variant                            | Steps/s, parallelism 25 | Steps/s, parallelism 100 |
| ---------------------------------- | ----------------------: | -----------------------: |
| Current workpool 0.4.7             |                    19.1 |                     28.9 |
| PR, default options                |                    15.3 |                     27.6 |
| PR, filter handler successes       |                    15.4 |                     28.6 |
| PR, transactional handlers         |                    17.8 |                     29.4 |
| PR, transactional handlers + steps |                    18.1 |                     31.0 |

At parallelism 100, handlers + steps improve from 28.9 to 31.0 steps/s including
admission (7%). At parallelism 25 they fall from 19.1 to 18.1 steps/s, despite
matching execution throughput.

## Direct workpool throughput

Each trial batch-enqueues 500 mutations that write independent completion rows.
The registered success callback returns immediately. Values are **median
jobs/second (min–max)**, excluding admission but including the completion tail.

| Variant                      |   Parallelism 25 |    Parallelism 100 |
| ---------------------------- | ---------------: | -----------------: |
| Current workpool 0.4.7       | 50.3 (48.7–51.2) |   85.2 (79.8–88.7) |
| PR, default options          | 49.7 (48.2–52.4) |   84.1 (81.3–93.1) |
| PR, filter success callbacks | 45.6 (32.2–46.1) |   93.4 (92.2–95.1) |
| PR, transactional mutations  | 47.7 (47.0–48.6) | 105.9 (99.1–106.6) |

At parallelism 100, transactional completion improves direct work throughput by
24% over the current package, 26% over PR defaults, and 13% over filtering
alone. Including admission, it improves from 79.4 to 95.1 jobs/s (20%). At
parallelism 25, there is no throughput gain. Direct mutation admission was about
0.4–0.6 seconds.

## Scheduled executions

These are median successful scheduled function executions per measured batch,
including the active component's loop overhead. They exclude driver actions,
queries, idle activity from other variants, and nested UDF calls. They are not a
billing estimate. All work, completion, and ignored-success callback counts were
checked against exact expectations in the execution logs.

| Variant                            | 500 direct jobs, P=100 | 100 five-step workflows, P=25 | 100 five-step workflows, P=100 |
| ---------------------------------- | ---------------------: | ----------------------------: | -----------------------------: |
| Current workpool 0.4.7             |                   1522 |                          3410 |                           3335 |
| PR, default options                |                   1522 |                          3418 |                           3337 |
| PR, filter handler successes       |                   1021 |                          2816 |                           2737 |
| PR, transactional handlers         |                    521 |                          2203 |                           2135 |
| PR, transactional handlers + steps |                      — |                          1202 |                           1135 |

For every 100 five-step workflows, all variants execute **1,100 work wrappers**
(600 handlers + 500 mutation steps). Filtering removes 600 ignored handler
success callbacks. Transactional handlers additionally remove 600 completion
mutations. Transactional steps remove another 500 completion mutations and 500
scheduled step callbacks; the journal/resume callback still executes inside each
step transaction.

That yields about **36% fewer scheduled executions for transactional handlers**
and **66% fewer for handlers + steps** at parallelism 100. Direct transactional
jobs similarly remove 500 completion mutations and 500 ignored callbacks per
batch. Most of the remaining scheduled executions are the work wrappers
themselves.

## Interpretation and follow-up

The ignored-success handler sites are `pool.enqueueWorkflow` and the
asynchronous start/restart sites in `workflow.ts`. The generator applies status
filtering only there. The mutation-step variant retains
`internal.pool.onComplete` and adds `completeTransactionally: true` in
`journal.ts`. Nested-workflow cleanup is another candidate with no success
callback, but cleanup throughput was not measured.

The reduction in scheduled executions is much larger than the throughput
improvement because the workflow, journal, and resume work still has to run. The
experiment does not isolate which scheduler/runtime costs limit the remaining
throughput.

Handler-only completion is the narrower change to consider first. Transactional
mutation-step completion additionally changes rollback behavior if its success
callback throws: the step's writes roll back too. Before adopting it in the
library, exercise callback-failure recovery, oversized/near-limit results,
cancellation races, restart, and nested workflow behavior against the
experimental component. These throughput tests establish successful execution
and ordinary failed and canceled work. They do not establish full migration
compatibility.

## Verification and reproduction

All 72 trials passed final status/result checks, exact completion counts, unique
indices, and missing/duplicate step-write checks. The eight preflight failure
and cancellation cases also passed; failed mutations left no successful-write
marker. The log audit found no trial runtime errors and verified complete
wrapper, completion, and ignored-success callback coverage. No PR measured trial
had an OCC retry; baseline retry counts are in the artifact.

The existing suite passed **123 tests in 13 files**. Root and experiment
TypeScript checks passed. Lint passed with three existing `.filter()` warnings.
The isolated app was deployed successfully and can be regenerated from the
source checkout.

See [README.md](README.md) for setup and method details. The exact measured run
was:

```sh
npm run bench:workpool -- --repeats=3 --parallelism=25,100 --jobs=500 --flows=100 --steps=5 --output=experiments/workpool/results.json
node experiments/workpool/summarize.mjs experiments/workpool/results.json
```

[results.json](results.json) contains every sample, package integrities,
per-function execution counts, retry counts, and summaries. The full execution
stream remains in the ignored `results.logs.jsonl` file locally. Pilot/smoke
runs are excluded.
