---
"@convex-dev/workflow": patch
---

A workflow that fails after parallel steps is no longer replayed by the extra
handler runs those steps queued. They now return early instead of failing with
"Workflow not running" and being counted as Workpool failures. (#327)

Handler runs and handler failure notifications for a workflow that already
finished, was restarted or was cleaned up now return without throwing. (#328)
