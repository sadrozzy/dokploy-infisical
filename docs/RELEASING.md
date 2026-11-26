# Release process

Nothing is published by CI on a push or pull request. Releases are manual and require all of the following:

1. Create the `sadrozzy/homebrew-tap` repository with a `Formula/` directory.
2. Configure npm trusted publishing for this GitHub repository and the `release.yml` workflow.
3. Add a `HOMEBREW_TAP_TOKEN` repository secret with write access only to the tap repository.
4. Protect the GitHub `release` environment with required reviewers.
5. Update the version in `package.json`, install to refresh `bun.lock`, and merge the change.
6. Run the **Release** workflow manually. Enter the exact package version and type `PUBLISH`.

The workflow verifies the version and tests, builds native binaries on all four target architectures, publishes the npm package, creates the GitHub release with checksums, and updates the Homebrew formula. A failure before the publish jobs makes no external changes.

For a local preflight without publishing:

```bash
bun install --frozen-lockfile
bun run check
bun run test:runtimes
bun run test:install
npm pack --dry-run
```
