---
"@convex-dev/workflow": minor
---

Preserve `ConvexError` identity and structured error data when catching failed
steps, including inline calls, queued functions, nested workflows, and journal
replay. Raises the `@convex-dev/workpool` peer minimum to 0.4.16. Oversized
failures are replaced with a bounded diagnostic so they can still be journaled.
