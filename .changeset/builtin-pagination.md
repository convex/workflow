---
"@convex-dev/workflow": minor
---

`workflow.list`, `listByName` and `listSteps` (and their client wrappers) now
use Convex's built-in pagination instead of `paginator` from convex-helpers.
(#306)

- Cursors are now opaque strings instead of JSON arrays. Cursors held by clients
  from before the upgrade won't be valid.
- A query can paginate only once, counting nested component calls, so calling
  these from an app query that already paginated (or calling them more than once
  in one query) will error. Calls from mutations are not limited.
