# Release flow

`main` is the development branch. `release` holds the version shipped to npm.
Use PRs for changes to both branches. Do not push directly to `release`.

1. Make a change on a feature branch and open a PR into `main`.
2. Set the next stable version in `package.json` and `package-lock.json` on `main`.
   Use `npm version patch --no-git-tag-version` when a patch version is required.
   The first version for this flow is already set to `0.2.2`.
3. Wait for `Verify` to pass. Review and merge the PR into `main`.
4. Open a PR with base `release` and head `main`. Review the version and package changes.
5. Merge that PR with a merge commit. Do not squash or rebase this branch promotion.
   A merge commit keeps the shared history for the next release.
6. The push to `release` runs the full CI workflow again.
7. Approve the `npm` environment job. It publishes the tested npm tarball to `latest`.

A feature PR or a push to `main` cannot start the publish workflow.
A version that is already on npm is a successful no-op.
Prerelease versions and mismatched lockfile versions fail the publish job.
If publishing fails before npm accepts the package, fix the cause and rerun the job.
Do not change a published version. Use a new version for a package fix.
A GitHub release or tag does not start npm publishing in this flow.

## One-time hosted setup

- Make `main` the GitHub default branch. Keep `master` until old links and work are checked.
- Create `release` from the same starting commit as `main`.
- Protect `main` and `release`: require a PR and the `Verify` status check, and block force pushes and deletion.
- Create the GitHub environment `npm`. Allow deployments only from `release`.
  Add `0xjimmy` as a required reviewer. Permit self-review for the single-maintainer workflow.
- In the npm settings for `ether-state`, add a GitHub Actions trusted publisher:
  - Organization or user: `0xjimmy`
  - Repository: `ether-state`
  - Workflow filename: `npm-publish.yml`
  - Environment name: `npm`
  - Allowed actions: enable `Allow npm publish`.
- After a successful OIDC publish, remove the unused GitHub `NPM_TOKEN` secret.
  Revoke the old npm token if it still exists. The token value must not enter source or logs.
- Select npm's option to require 2FA and disallow bypass tokens after confirming that no other release tools need them.

The workflow uses a supported npm CLI and Node 24 on a GitHub-hosted runner.
The publish job has `id-token: write`. It does not use `NPM_TOKEN`.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Review findings on 2026-09-14

Before these changes, the default branch was `master`. Every push to it ran the
publish workflow on Node 18 with checkout/setup-node v3 and an npm-publish action.
The only GitHub secret listed was `NPM_TOKEN`, last updated on 2023-08-31.
Its value and validity were not inspected.
There were no branch protection rules, rulesets, or environments. GitHub returned
no recent workflow runs or releases, so no current hosted success was available.

npm listed `ether-state@0.2.1` as `latest`, last published on 2023-08-31.
The signed-in package settings showed `0xjimmy` with write access, no trusted
publisher, and publishing through 2FA or a granular token with bypass enabled.

The old lockfile had two high-severity dependency findings. Updating ethers to
6.17.0 removed them. ethers pins an old Node type package. This package declares
the current Node 22 types so consumers can check declarations with `skipLibCheck: false`.
