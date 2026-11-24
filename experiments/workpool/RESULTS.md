# Transactional mutation/query completion on Workflow and workpool 0.5.0

Transactional completion gives mutation workflows a modest throughput gain and a
substantial reduction in scheduling overhead on current Workflow/workpool 0.5.0:
**+15.6% at parallelism 25 and +8.0% at 100**, with **57.5–58.5% fewer scheduled
executions** versus the release. Including admission, gains are **14.2% and
5.5%**.

The incremental benefit of making mutation **steps** transactional after
handlers are already transactional is **+2.2% / +9.9%**, with another
**45.5–46.8% fewer scheduled executions**. This supports mutation
transactionality as an opt-in performance feature for these inexpensive
workflows.

Query-specific transactionality does **not** demonstrate an additional
throughput gain here: **−2.0% / −1.8%** versus transactional handlers alone,
while scheduling **66.9–73.4% more executions**. Handler-only transactions
already capture the measured query-workflow benefit. Full query treatment is
faster than the released baseline (+18.7% / +5.2%), but attributing that gain to
transactional query completion would be misleading.

Queries normally run in action batches. Opting them into transactional
completion replaces those batches with individual mutation wrappers. It removes
nested completion calls but adds scheduler work. These results support releasing
the mutation option; they provide no throughput case for additionally opting
queries in by default. Three rounds on shared development infrastructure are
descriptive, not a universal speedup estimate. In particular, the
transaction-disabled PR control differed from the release, and one handler-only
query trial was much slower; the tables retain both controls and all ranges.

## Measured throughput

Committed workflow steps/second, excluding admission and idle settling. Cells
show median (min–max) of three measured rounds. Each measured trial runs 100
independent workflows with five sequential steps; each configuration has a
separate 10-workflow warm-up.

### Mutation steps

| Configuration                  |   Parallelism 25 |  Parallelism 100 |
| ------------------------------ | ---------------: | ---------------: |
| Released 0.5.0                 | 21.4 (20.0–22.6) | 49.1 (48.0–50.4) |
| PR, transactions off           | 22.4 (14.1–22.6) | 37.4 (36.1–49.9) |
| Transactional handlers         | 24.3 (19.7–24.4) | 48.3 (46.1–48.9) |
| Transactional handlers + steps | 24.8 (24.5–24.8) | 53.1 (51.7–54.5) |

### Query steps

| Configuration                  |   Parallelism 25 |  Parallelism 100 |
| ------------------------------ | ---------------: | ---------------: |
| Released 0.5.0                 | 20.7 (16.8–21.4) | 52.8 (41.6–54.0) |
| PR, transactions off           | 17.4 (15.0–20.4) | 53.8 (51.2–54.9) |
| Transactional handlers         |  25.1 (9.0–28.1) | 56.6 (54.5–57.1) |
| Transactional handlers + steps | 24.6 (19.9–25.0) | 55.6 (52.7–56.3) |

## Release impact

Full transactional handlers and steps versus released 0.5.0:

| Workload | Parallelism | Throughput | Including admission | Scheduled executions |
| -------- | ----------: | ---------: | ------------------: | -------------------: |
| mutation |          25 |     +15.6% |              +14.2% |               -57.5% |
| mutation |         100 |      +8.0% |               +5.5% |               -58.5% |
| query    |          25 |     +18.7% |              +13.7% |               -12.1% |
| query    |         100 |      +5.2% |               +3.1% |               -10.0% |

The same-package control isolates the option from other PR changes:

| Workload | Parallelism | Full transactional vs PR off | Handlers only vs PR off | Steps added vs handlers only |
| -------- | ----------: | ---------------------------: | ----------------------: | ---------------------------: |
| mutation |          25 |                       +10.9% |                   +8.5% |                        +2.2% |
| mutation |         100 |                       +41.9% |                  +29.1% |                        +9.9% |
| query    |          25 |                       +41.2% |                  +44.1% |                        -2.0% |
| query    |         100 |                        +3.2% |                   +5.1% |                        -1.8% |

## Scheduled executions

Median successful scheduler-initiated executions, including pool loops. Nested
calls remain UDF executions; these counts are not billing estimates.

| Workload | Parallelism | Released | PR off | Handlers | Handlers + steps |
| -------- | ----------: | -------: | -----: | -------: | ---------------: |
| mutation |          25 |     2824 |   2826 |     2202 |             1199 |
| mutation |         100 |     2735 |   2735 |     2134 |             1135 |
| query    |          25 |     1367 |   1369 |      720 |             1202 |
| query    |         100 |     1260 |   1255 |      654 |             1134 |

## Versions, method, and validation

Run began 2026-11-24T06:39:52.485Z on isolated development deployment
`effervescent-horse-682`. Workflow main `0f13d31` (0.5.0), released workpool
0.5.0, Convex SDK 1.51.0, Node v24.22.1. The experimental package rebases PRs
#238/#239 onto workpool main `48d328b`; source and package integrity are
recorded in [vendor](vendor/README.md) and [results.json](results.json).

All variants use current Workflow source and preserve ignored-success exclusion.
No library runtime or peer dependency changes are required by the benchmark.
Workpool 0.5.0 already invokes normal callbacks inline during its separate
completion transaction. The treatment joins work and completion, removing the
separate completion mutation for mutations and switching queries from action
batches to individual mutation wrappers with independent query snapshots.

Mutation steps write independent rows; query steps read one seeded row per
workflow. Every workflow result and completion index is checked; mutation trials
verify all 500 step writes, and query trials verify zero step writes. Trial
order rotates and reverses. Queues drain between trials. The strict JSONL audit
verifies the full matrix, wrapper counts, completion counts (including nested
query completions), and absence of ignored-success scheduler callbacks.

Measured trials: 48 samples, 0 retry attempts, 0 runtime errors. Warm-ups: 16
samples, 36 retry attempts, 0 runtime errors.

All three selected direct-pool preflights passed failure, cancellation, and
failed-write rollback. These do not test workflow-step callback failure or
rollback. Workflow build/typechecks and 187 tests pass; rebased workpool passes
321 tests; lint has three existing warnings.

These finite batches use cheap operations on a shared development backend. Three
rounds describe observed variation, not confidence intervals or guaranteed
production gains. Mutation callback failures roll back work and completion
together. Transactional query reads use independent snapshots and can be stale
when completion commits. This successful-throughput experiment does not
establish full failure-recovery or migration compatibility.

```sh
npm ci
npm run bench:workpool:push
npm run bench:workpool -- --repeats=3 --parallelism=25,100 --workloads=mutation,query --modes=baseline,prFiltered,transactional,allMutations --flows=100 --steps=5 --output=experiments/workpool/results.json
node experiments/workpool/summarize.mjs experiments/workpool/results.json
```

Raw logs are retained locally as ignored `results.logs.jsonl`. Earlier September
measurements are preserved in
[historical](historical/RESULTS-september-0.4.12.md); they use older packages
and must not be combined with this run.
