---
"@convex-dev/workflow": patch
---

`cleanup` now deletes all of the workflow's events, including ones sent to it
that no step waited for. Before, those rows were left behind.
