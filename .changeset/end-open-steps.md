---
"@convex-dev/workflow": patch
---

When a workflow ends for any reason (success, failure or cancel), steps still in
progress are marked canceled: their queued jobs are canceled, their child
workflows are canceled, and their event waits stop waiting. This covers branches
of a `Promise.all` beside a step that failed, and steps the handler started but
never awaited. Before, those steps stayed in progress forever, so `restart` on a
canceled workflow never ran the handler, and a restarted workflow could wait
forever on a step from the run before. A result that arrives for a step that
already ended is ignored. A workflow replays once its last step in progress
ends, not after each one. Sending an event by name skips waits that already
ended and goes to the next one.
