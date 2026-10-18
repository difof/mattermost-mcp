# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
Each release-worthy change ships with a markdown file here describing the bump.

## Add a changeset

```bash
npx changeset
```

Pick the bump level (`patch` / `minor` / `major`) and write a one-line summary.
This creates a file like `.changeset/funny-pandas-clap.md`. Commit it with your PR.

## What the CI does

The base branch is `master`. Automatic npm publishing is restricted to the upstream
repository in `release.yml`; this fork is installed from source. Before enabling
publishing for the fork, configure its own package name and npm publishing identity.

When enabled, on push to `master`, the release workflow:

1. If unreleased changesets exist → opens/updates a **"Version Packages"** PR that
   consumes them, bumps `package.json`, and writes `CHANGELOG.md`.
2. When that PR is merged → builds and runs `changeset publish` → publishes to npm
   and tags the release.

So nothing publishes until the Version Packages PR is merged.
