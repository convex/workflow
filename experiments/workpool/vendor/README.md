# Rebased transactional workpool

Released control: `@convex-dev/workpool@0.5.0`. Experimental source: workpool PR
#239 at `b49510e00816a6265128a835b51a2753e674a1ac` (includes mutation PR #238 at
`aa5234c59dafa2e367769412907458ff659330e4`), rebased onto workpool main
`48d328b5130a65409ec3be3994594d53f6692c28`. The conflict-free local rebase
produced `2bbbe6a9f663e173fbea092a50db91d6c1b1e350`.

`transactional.patch` records the full source diff from that main commit. The
checked-in tarball was built from that source and renamed in package.json to
`@convex-dev/workpool-transactional` before packing. The distinct package name
prevents TypeScript from merging the two 0.5.0 package identities. The
package-lock integrity pins the actual artifact. No source changes beyond the
patch were made. Vendoring avoids benchmarking the PR's older pre-rebase
published package against today's release.

To rebuild in a separate directory:

```sh
git clone https://github.com/convex/workpool.git workpool-experiment
cd workpool-experiment
git checkout 48d328b5130a65409ec3be3994594d53f6692c28
git apply /absolute/path/to/transactional.patch
npm ci
npm pkg set name=@convex-dev/workpool-transactional
npm pack
```

Replace `workpool-transactional-rebased-0.5.0.tgz` with the resulting tarball
and refresh the root lockfile if rebuilding. Tarball hashes may differ because
npm includes metadata; the source patch and base commit define the treatment.
