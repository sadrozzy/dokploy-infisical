# dokploy-infisical

[![CI](https://github.com/sadrozzy/dokploy-infisical/actions/workflows/ci.yml/badge.svg)](https://github.com/sadrozzy/dokploy-infisical/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dokploy-infisical.svg)](https://www.npmjs.com/package/dokploy-infisical)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**English** · [Русский](README.ru.md)

A terminal UI for safely syncing Dokploy environment secrets with Infisical. It builds a reviewable plan, encrypts a rollback snapshot before the first write, verifies both systems after the migration, and never prints secret values.

> Community project. Not affiliated with Dokploy or Infisical.

> The repository has not had its first public release yet. The commands below are configured and tested locally/through CI, but the npm package and Homebrew formula only become available after the manual release workflow is approved and run.

## TUI

These screenshots are generated from the real OpenTUI components by `bun run screenshots`; no secrets or production data are used.

![Workflow selection](docs/screenshots/workflows.svg)

![Project and service selection](docs/screenshots/project-selection.svg)

## Features

- **Dokploy → Infisical** — copy raw values to `/<project>/_shared` or `/<project>/<service>`, then replace service values with Vault references.
- **Infisical → Dokploy** — attach missing Vault references without copying plaintext back to Dokploy.
- **Encrypted rollback** — AES-256-GCM snapshots, automatic rollback after a failed write, and manual restoration from the TUI or CLI.
- **Dry review and verification** — inspect the exact number of secrets and rewrites before applying them, then read both systems back.
- **Safe repeats** — existing `${{vault.*}}` references are immutable and never become secret plaintext.
- **Explicit redeploy** — redeploy is a separate confirmation after a verified migration; it is never automatic.

## Install

Every installation method provides the same command: `dokploy-infisical`.

### npm

Requires Node.js 26.4 or newer.

```bash
npm install --global dokploy-infisical
```

### pnpm

Requires Node.js 26.4 or newer.

```bash
pnpm add --global dokploy-infisical
```

### Bun

Requires Bun 1.3.14 or newer.

```bash
bun add --global dokploy-infisical
```

### Homebrew

The Homebrew package contains a standalone binary and does not require Node.js or Bun.

```bash
brew install sadrozzy/tap/dokploy-infisical
```

Supported platforms are macOS and Linux on arm64 and x64.

## Quick start

```bash
dokploy-infisical
```

The first-run wizard asks for:

- Dokploy URL and API token;
- Infisical URL;
- Universal Auth Client ID and Client Secret;
- Infisical project ID and environment slug;
- the existing Dokploy Vault provider name.

Non-secret settings are stored in `~/.config/dokploy-infisical/config.json`. On macOS, credentials are stored in Keychain. On Linux, supply credentials through the environment:

```bash
export DOKPLOY_API_KEY="..."
export INFISICAL_CLIENT_ID="..."
export INFISICAL_CLIENT_SECRET="..."
dokploy-infisical
```

The Dokploy token may also be provided as `DOKPLOY_AUTH_TOKEN`.

## Requirements

- a Dokploy API token;
- an Infisical Machine Identity with Universal Auth access to the target project;
- an existing Dokploy Vault provider assigned to the projects/environments being migrated;
- a terminal with TTY support;
- either Bun 1.3.14+ or Node.js 26.4+ for npm-based installations. Homebrew uses a standalone binary.

## Usage

```text
dokploy-infisical
dokploy-infisical rollback <migration-id>
dokploy-infisical --help
dokploy-infisical --version
```

Keyboard controls:

| Keys | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | Move |
| `←` / `→` | Collapse or expand a project |
| `space` / `enter` | Select a project or service |
| `a` | Toggle all projects |
| `tab` | Focus the Continue action |
| `m` | Open migration review |
| `esc` | Go back |
| `q` | Quit |

## Migration and rollback

The forward migration flow is:

1. Verify the Dokploy, Infisical, and Vault provider connections.
2. Select projects or services.
3. Resolve Dokploy project references and build a dry plan.
4. Review secrets, rewrites, conflicts, and warnings.
5. Create an encrypted rollback snapshot.
6. Create Infisical folders and secrets.
7. Replace Dokploy values with Vault references.
8. Read both systems back and verify the result.
9. Optionally confirm redeploys as a separate action.

Snapshots are stored under:

```text
~/.local/share/dokploy-infisical/migrations/<migration-id>.json.enc
```

The recovery password is never stored. Manual rollback does not redeploy services:

```bash
dokploy-infisical rollback <migration-id>
```

## Update and uninstall

| Manager | Update | Uninstall |
| --- | --- | --- |
| npm | `npm update --global dokploy-infisical` | `npm uninstall --global dokploy-infisical` |
| pnpm | `pnpm update --global dokploy-infisical` | `pnpm remove --global dokploy-infisical` |
| Bun | `bun update --global dokploy-infisical` | `bun remove --global dokploy-infisical` |
| Homebrew | `brew upgrade dokploy-infisical` | `brew uninstall dokploy-infisical` |

Uninstalling does not delete configuration, Keychain entries, or encrypted snapshots.

## Development

```bash
bun install
bun run start
```

Checks and reproducible screenshots:

```bash
bun run check
bun run test:runtimes
bun run test:install
bun run screenshots
```

CI tests type safety, the migration engine, the TUI, both runtimes, native compilation, and installation from the packed npm tarball with npm, pnpm, and Bun on macOS and Linux.

## Publishing

Pushes and pull requests never publish packages. The release workflow is manual, checks the version, requires the literal confirmation `PUBLISH`, and can be protected with GitHub environment reviewers. It publishes npm through trusted publishing, creates GitHub release assets with SHA-256 checksums, and updates `sadrozzy/homebrew-tap` using a narrowly scoped token.

See [the release checklist](docs/RELEASING.md) before the first release.

## License

[MIT](LICENSE)
