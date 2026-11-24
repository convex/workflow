---
"@convex-dev/workflow": patch
---

Allow apps to use Workpool 0.5.x or keep using 0.4.16.

Workpool 0.5 requires Convex 1.47 or later. If upgrading from Workpool earlier
than 0.4.15, first deploy Workpool 0.4.15 and run
`npx convex run --component workflow/workpool migrations:backfillPendingStartIds`
for each installed instance, adjusting the component path for custom names.
