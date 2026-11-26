---
"@convex-dev/workflow": patch
---

Inline query and mutation steps now get the same 800 KiB result limit as queued
steps. Before, a larger inline result succeeded, and one over 1 MiB made the
whole handler run throw "Value is too large", which the workflow couldn't catch.
