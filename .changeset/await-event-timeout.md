---
"@convex-dev/workflow": minor
---

`step.awaitEvent` takes an optional `timeout` in milliseconds. With it, the call
resolves to `{ kind: "event", value }` or `{ kind: "timeout" }` instead of
throwing or waiting forever. A timed wait by name also takes an event of that
name sent before the wait started, as untimed waits do. A send that arrives
after a timed wait ended (timed out, already received, or the workflow finished
or was canceled) is dropped: it doesn't throw and isn't stored for a later wait.
Waits without `timeout` are unchanged.
