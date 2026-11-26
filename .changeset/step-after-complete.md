---
"@convex-dev/workflow": patch
---

When a workflow handler fails inside `Promise.all` while another branch is
asking for its next step, the handler run now waits for that step request to
finish before marking the workflow failed. Before, the request could still be
running when the mutation returned. It then threw "Workflow not running" and
could leave a Workpool job marked running forever.
