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
6. A last job waits for npm to list the version, downloads it from the registry, checks it is the file CI built and runs the smoke test on it. Its summary says how long npm took. The release is installable when this job is green.

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
- The `Protect main` ruleset requires a PR, resolved review threads, a green CI run and a conventional PR title. It requires no approval. Repo admins can bypass it.
- A GitHub environment named `npm` lists the people who may approve a publish.
- The `cc-tap` package on npm trusts this repo, the `release.yml` workflow and the `npm` environment. No npm token is stored in GitHub.
- A GitHub App installed on this repo opens the release PR, so that GitHub runs CI on it. The workflow reads the app's client ID from the `RELEASE_APP_CLIENT_ID` variable and its private key from the `RELEASE_APP_PRIVATE_KEY` secret. The app needs read and write access to contents and pull requests, and nothing else. Without those two settings the workflow falls back to a personal `RELEASE_PLEASE_TOKEN` secret, which expires.

## When a publish fails

The tag and the GitHub release already exist at that point, and nothing is on npm.

- If the cause is outside the repo, such as an npm outage or a missing approval, re-run the failed job from the workflow run page.
- If the cause is in the workflow, merge the fix to `main` first. A re-run would use the workflow as it was at the release commit. Then open Actions, choose the `Release` workflow, click "Run workflow" on `main` and give it the tag, such as `v0.12.0`. It builds that tag, runs the smoke test and waits for the same approval before it publishes.
- If the cause is in the code, merge the fix and release the next patch version.

Do not publish the version by hand, because the package would lose its provenance record.
