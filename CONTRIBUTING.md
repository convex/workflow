# Developing guide

## Running locally

```sh
npm ci
npm run dev
```

## Testing

```sh
npm run build
npm run check
npm run test:e2e
```

When component APIs change, regenerate and commit the generated files:

```sh
npm run build:codegen
```

## Releases

Include a changeset with changes that need a release:

```sh
npx changeset
```

To prepare a release from an up-to-date checkout:

```sh
npm ci
npm run build
npm run check
npx changeset version
```

Review and commit the version, changelog, and consumed changesets, then merge
through a checked PR. A push to main stages the latest version-bump commit in
that push.

Review the staged package on npm's **Staged Packages** page and approve it, or
run:

```sh
npm stage approve <stage-id>
```

For a branch prerelease, prepare a prerelease version with Changesets and
dispatch **Release** from the Actions page on that branch. The first prerelease
identifier selects the npm channel, such as `alpha`. Stable releases require
main.

For recovery, dispatch **Release** on the appropriate ref with the 40-character
SHA of a version-bump commit reachable from that ref.

| Failure                                         | Recovery                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Transient failure before successful staging     | Retry failed jobs for the same commit.                                                 |
| Staging succeeded; tagging failed               | Retry only failed jobs.                                                                |
| Upload outcome uncertain                        | Inspect npm before retrying; recover the tag only after verifying the staged artifact. |
| Fix requires changing the release commit's code | Prepare a new version-bump commit.                                                     |
| Candidate rejected after staging                | Leave its tag and prepare a new version.                                               |
