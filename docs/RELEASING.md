# Releasing

cc-tap publishes to npm from GitHub Actions. Nobody runs `npm publish` on a laptop.

## Day to day

1. Open a PR. Its title must be a conventional commit, such as `feat(sessions): compare two sessions` or `fix: price cache writes at 2x input`. CI rejects any other title.
2. Squash-merge the PR. The title becomes the commit on `main`.
3. release-please opens a release PR, or updates the one already open. The PR holds the next version number and the new section of `docs/CHANGELOG.md`.

The type in the title decides the version. A `fix` raises the patch number and a `feat` raises the minor number. While cc-tap is below 1.0, a breaking change marked with `!` also raises the minor number. Other types, such as `docs`, `ci` and `chore`, appear in no changelog and trigger no release on their own.

## Cutting a release

1. Read the open release PR. Edit the changelog section in the PR if a line needs more context. Do this last, because release-please rewrites the PR and drops the edit each time something else merges to `main`.
2. Merge it. release-please creates the `vX.Y.Z` tag and the GitHub release.
3. The `Release` workflow checks out the tag, runs the tests, builds the bundle, packs the tarball and runs the smoke test on it.
4. The publish job then waits. A reviewer of the `npm` environment opens the workflow run and approves it.
5. The job publishes the tarball the smoke test ran. npm records which commit and workflow built it.

## The smoke test

`scripts/smoke-test.mjs` installs the packed tarball in an empty directory, starts `cc-tap --demo` and checks that the dashboard and `/api/sessions` answer. CI runs it on every PR, so a bundle that builds but does not start fails before it reaches `main`.

Run it locally with:

```bash
npm run build:dist
npm pack
node scripts/smoke-test.mjs cc-tap-*.tgz
```

## Setup this depends on

- GitHub allows only squash merges on this repo.
- The `Protect main` ruleset requires a PR, one approving review, resolved review threads and a green CI run. Repo admins can bypass it.
- A GitHub environment named `npm` lists the people who may approve a publish.
- The `cc-tap` package on npm trusts this repo, the `release.yml` workflow and the `npm` environment. No npm token is stored in GitHub.
- The `RELEASE_PLEASE_TOKEN` secret lets release-please open its PR as a real identity. Without it the release PR still opens, but GitHub runs no CI on it, and the ruleset then blocks the merge. The token is a personal one, so it expires, and its owner is the author of every release PR and cannot approve it.

## When a publish fails

The tag and the GitHub release already exist at that point. Fix the cause, then re-run the failed job from the workflow run page. Do not publish the version by hand, because the package would lose its provenance record. If the fix needs a code change, merge it and release the next patch version.
