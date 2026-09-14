# Release flow

`main` is the development branch. `release` holds the version shipped to npm.
Use PRs for changes to both branches. Do not push directly to `release`.

1. Make a change on a feature branch and open a PR into `main`.
2. Set the next stable version in `package.json` on `main`. Run `bun install` if dependencies change.
3. Wait for `Verify` to pass. Review and merge the PR into `main`.
4. Open a PR with base `release` and head `main`. Review the version and package changes.
5. Merge that PR with a merge commit. Do not squash or rebase this branch promotion.
6. The workflow repeats CI, publishes to npm, creates the versioned GitHub Release,
   and publishes the GitHub Packages copy. No separate deployment approval is required.

For `0.2.3`, the outputs are:

| Destination | Name |
| --- | --- |
| npm | `ether-state@0.2.3`, tag `latest` |
| GitHub Release | Title `v0.2.3`, tag `v0.2.3` |
| GitHub Packages | `@0xjimmy/ether-state@0.2.3` |

The publish job is named `Release v0.2.3`. The deployment environment is named
`npm` because npm trusted publishing binds to that name. Its URL points to the
versioned GitHub Release.

## Package and source checks

The npm tarball is installed and tested before publication. On a release run,
its manifest includes `gitHead` with the release commit. GitHub publication waits
for that exact npm version, downloads its tarball, and checks the SHA-512 digest.
It uses the source commit inside the tarball for the GitHub tag. It rejects an
existing tag that points to a different commit.

The GitHub Packages copy uses the published npm files. Only its package name,
repository metadata, and publishing configuration change. The npm package keeps
its unscoped name. CI tests the npm tarball through ESM, CommonJS, and declarations.
Unit tests check the GitHub package manifest conversion.

A feature PR or a push to `main` cannot start publishing. Existing npm versions,
GitHub releases, and GitHub package versions are skipped on reruns. A version
cannot move the `latest` tag backwards. Prerelease versions and mismatched
dependency lockfiles fail the workflow. Bun installs use `--frozen-lockfile`.
If a later step fails after npm publication, rerun
the job. It resumes the missing work with the published npm files.

Do not change a published version. Use a new version for a package fix. A GitHub
release or tag does not start npm publishing in this flow.

## Hosted settings

`main` is the GitHub default branch. Both `main` and `release` require PRs and the
`Verify` check. Force pushes and branch deletion are blocked. `main` requires an
up-to-date PR branch. `release` does not, because its PR checks test the proposed
merge and release merge commits must not force reverse merges into `main`.
Release PRs must come from this repository's `main` branch.

The `npm` environment permits only `release`. Its reviewer gate is disabled;
the release PR merge is the approval point. The npm trusted publisher is saved:

- Organization or user: `0xjimmy`
- Repository: `ether-state`
- Workflow filename: `npm-publish.yml`
- Environment name: `npm`
- Allowed actions include `npm publish`.

npm uses OIDC with `id-token: write`. GitHub Release and GitHub Packages steps use
the workflow's `GITHUB_TOKEN` with `contents: write` and `packages: write`. No new
personal token is required for publishing.

GitHub defaults a newly created package to private. After the first GitHub Packages
publish, check its package settings and set its visibility to public if needed.
The repository field links it to this repository. Package readers still need
GitHub registry authentication, including for public npm packages. Normal users
can install `ether-state` from npm without this extra setup.
See [GitHub's npm registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Merged feature branches delete automatically. Keep `main` and `release`.

## Initial migration

Before this setup, pushes to `master` published through Node 18 and `NPM_TOKEN`.
There were no branch protection rules, rulesets, or deployment environments.
The first OIDC release, `0.2.2`, passed all checks and published successfully.
The unused GitHub `NPM_TOKEN` secret was removed after that successful publish.
Revoke its old npm token if it still exists. Do not expose token values in source or logs.
