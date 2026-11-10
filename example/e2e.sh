#!/bin/sh
set -eu

# --once can return success after a failing --start command; require a success marker.
status_file=$(mktemp)
trap 'rm -f "$status_file"' EXIT
export E2E_STATUS_FILE="$status_file"
if [ -n "${BACKEND_VERSION:-}" ]; then
  set -- --local-backend-version "$BACKEND_VERSION" "$@"
fi
npx convex dev --once --typecheck-components --start 'node ./example/e2e.mjs && echo passed > "$E2E_STATUS_FILE"' "$@"
test "$(cat "$status_file")" = passed
