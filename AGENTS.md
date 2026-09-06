# AGENTS.md

agent-dev-env — sandbox VM image recipes plus the CLI that builds, runs,
and wires up developer sandbox VMs: macOS (Tart), Windows 11 ARM64
(QEMU / VMware Fusion), Ubuntu 24.04 ARM64 (VMware Fusion). The repo hosts
the Packer image recipes and the TypeScript CLI distributed as the
`agent-dev-env` npm package; the npm package bundles everything the CLI
needs at runtime.

## Table of Contents

- [Project Overview](#project-overview)
- [Technical Context](#technical-context)
- [Project Structure](#project-structure)
- [Building and Using the CLI](#building-and-using-the-cli)
- [Building Images](#building-images)
- [Releases, Tags, and Changelogs](#releases-tags-and-changelogs)
- [Contribution Instructions](#contribution-instructions)
- [Code Guidelines](#code-guidelines)
    - [Architecture](#architecture)
    - [Code Quality](#code-quality)
    - [Testing](#testing)
    - [Dependency Management](#dependency-management)
    - [Configuration & Documentation](#configuration--documentation)
    - [Project Conventions](#project-conventions)
    - [Markdown Formatting](#markdown-formatting)

## Project Overview

Two deliverables share this repo:

- **Image recipes** — `images/<platform>/` holds the per-platform Packer
  templates (`sandbox.pkr.hcl`), per-image vars files
  (`vars/<image>.pkrvars.hcl`, the single source of truth for versions),
  guest seeds (`autounattend.xml`, `autoinstall/`), and per-platform
  assets (e.g. `qemu-with-tpm.sh`). Images are published to GHCR.
- **The `agent-dev-env` CLI** — a TypeScript npm CLI that replaced the
  legacy shell scripts: per-platform runners, image lifecycle (build /
  deploy / tag), and diagnostics (`doctor`, `status`, `list`). The port is
  complete — the shell scripts are removed.

The CLI runs on the host (macOS, Apple Silicon only — Tart/VMware/QEMU
cannot virtualize ARM64 guests on Intel). VM state, logs, and caches live
under the `agent-dev-env` XDG-aware dirs (`src/lib/paths.ts`), not the
legacy shell-script paths.

## Technical Context

| Field | Value |
| --- | --- |
| Language | TypeScript 5.x, ES2022 target, strict mode |
| Runtime | Node.js 26+ (host: macOS Apple Silicon) |
| Package Manager | pnpm 10+ |
| CLI Framework | commander |
| Guest Transport | ssh2 (Phase 4 — Ubuntu VMware backend) |
| VM Tooling | Tart, Packer (tart-cli builder), QEMU + swtpm, VMware Fusion (vmrun) |
| Image Distribution | GHCR via tart push / oras push |
| Linting | oxlint (category-based config) + Knip |
| Formatting | Prettier 3.x, Markdownlint (markdownlint-cli2) |
| Unit tests | Vitest |
| Workspace | pnpm workspaces (`packages/*`; the CLI package is `agent-dev-env-cli`) |

## Project Structure

```text
agent-dev-env/
├── .github/workflows/        # CI: quality gate + npm publish (latest + canary) + GitHub release
├── packages/                 # pnpm workspace packages
│   ├── agent-dev-env-cli/      # The agent-dev-env CLI package (published)
│   │   ├── src/
│   │   │   ├── cli.ts          #   CLI entry point (commander)
│   │   │   ├── commands/       #   command implementations + register.ts
│   │   │   ├── lifecycle/      #   image logic: catalog.ts (discovery/vars),
│   │   │   │                   #   build.ts (dispatcher) + build-{macos,qemu,
│   │   │   │                   #   windows-vmware,ubuntu}.ts (flows) +
│   │   │   │                   #   build-shared.ts (prereqs/context/packer
│   │   │   │                   #   pipeline/arg builders) +
│   │   │   │                   #   build-watchdog.ts (VNC watchdog spawn),
│   │   │   │                   #   deploy.ts + tag.ts + watch-build.ts
│   │   │   ├── runners/        #   run framework + the macOS
│   │   │   │                   #   backend (macos*.ts: bridges/guest/rules/
│   │   │   │                   #   summary + macos-provenance.ts), the Ubuntu
│   │   │   │                   #   VMware backend
│   │   │   │                   #   (ubuntu*.ts: image/shared/bridges/guest/
│   │   │   │                   #   rules/summary), the Windows VMware
│   │   │   │                   #   backend (windows*.ts: image/guest/bridges/
│   │   │   │                   #   autologon/shared/summary, via the shared
│   │   │   │                   #   vmware-image.ts (clone/upgrade) +
│   │   │   │                   #   vmware-image-archive.ts (archive pick/base)/
│   │   │   │                   #   vmware-common.ts) and the
│   │   │   │                   #   Windows QEMU backend (windows-qemu.ts +
│   │   │   │                   #   qemu-image.ts + windows-qemu-summary.ts via
│   │   │   │                   #   the shared windows-bridges/windows-guest/
│   │   │   │                   #   windows-autologon + lib/qemu.ts)
│   │   │   ├── settings/       #   user-settings copy: shared builders
│   │   │   │                   #   (common.ts) + per-transport IO — macos.ts/
│   │   │   │                   #   macos-copy.ts (tart), ubuntu.ts/
│   │   │   │                   #   ubuntu-copy.ts (ssh2) and windows.ts/
│   │   │   │                   #   windows-copy.ts (psExec + SFTP, ssh2)
│   │   │   ├── lib/            #   foundations: logger, prompt, vars, template,
│   │   │   │                   #   ghcr, paths, exec, git, platform, vmrun,
│   │   │   │                   #   tart, ssh, network, qemu, provenance, ...
│   │   │   └── **/*.test.ts    #   co-located unit tests
│   │   ├── scripts/
│   │   │   └── copy-assets.mjs #   build step: tsc + esbuild bundles +
│   │   │                       #   copy assets/ + images/ into dist/
│   │   ├── tsconfig*.json      #   app (build) + test (noEmit) configs
│   │   └── dist/               #   build output (gitignored): compiled CLI +
│   │                           #   bundled bridge.js + guest-agent-*.js
│   ├── bridge-core/            # Zero-dep forwarder (endpoints, forwarder,
│   │                           # probe, host CLI entry bin.ts)
│   ├── guest-rules/            # Shared agent-rules probe/apply logic
│   ├── guest-agent-mac/        # macOS guest agent (launchd, env, rules)
│   ├── guest-agent-windows/    # Windows 11 ARM64 guest agent (schtasks,
│   │                           # named pipes; shared by qemu + vmware)
│   └── guest-agent-ubuntu/     # Ubuntu guest agent (systemd units, env)
├── assets/                     # Runtime assets bundled into the npm package
│   ├── rules/                  # Agent rules for guests
│   ├── watchdog/               # VNC build watchdog
│   └── images/                 # images/ snapshot, copied at publish
├── images/                     # Image recipes (the repo's other deliverable)
│   ├── mac/                    # macOS (Tart) template + vars + CHANGELOG
│   ├── windows-arm64-qemu/     # Windows 11 ARM64 (QEMU) template +
│   │                           # qemu-with-tpm.sh + vars + CHANGELOG
│   ├── windows-arm64-vmware/   # Windows 11 ARM64 (VMware) template + vars
│   │                           # + CHANGELOG
│   └── ubuntu-arm64-vmware/    # Ubuntu 24.04 ARM64 (VMware) template + vars
│                               # + CHANGELOG
├── docs/                       # User guides (cli/macos/windows-qemu/windows-
│                               # vmware/ubuntu-vmware/ssh-agent)
├── DEVELOPMENT.md              # Build/debug guide: CLI + recipes + prerequisites
├── CHANGELOG.md                # Repo changelog (Unreleased on top)
├── tsconfig.base.json          # Shared TypeScript compiler options
├── oxlint.config.ts            # oxlint category-based config
├── knip.config.ts              # Knip unused-export analysis config
├── vitest.config.ts            # Vitest configuration
└── package.json                # Private workspace root (dev deps + scripts)
```

## Building and Using the CLI

### Prerequisites

- macOS on Apple Silicon — Tart/QEMU/Fusion cannot virtualize ARM64
  guests on Intel.
- Node.js 26+, pnpm 10+ (`corepack enable` or `npm install -g pnpm`).
- Per-platform runtime tooling for `run`/`build` — see
  [Building Images](#building-images) and DEVELOPMENT.md for the full
  list; `agent-dev-env doctor` checks everything.

### Building the CLI

`pnpm install` once, then `pnpm build`:

- compiles the CLI TypeScript into
  `packages/agent-dev-env-cli/dist/`,
- bundles the workspace guest-side packages into single-file JS
  artifacts (`dist/assets/bridge/bridge.js`,
  `dist/assets/guest/guest-agent-*.js`, esbuild),
- copies the runtime assets (`assets/**`) and the `images/**` snapshot
  into `dist/` (`packages/agent-dev-env-cli/scripts/copy-assets.mjs`),
- copies the repo root `README.md` into `packages/agent-dev-env-cli/`
  root — npm shows a package readme only from the package root, so the
  published `agent-dev-env` ships the repo README (generated file,
  gitignored).

`dist/` is the npm package payload — `npm pack --dry-run` (from
`packages/agent-dev-env-cli`) verifies it.

`pnpm publish-npm` (root script) builds and publishes `agent-dev-env` to
npm: it runs `pnpm build` and then `pnpm --filter
./packages/agent-dev-env-cli publish --no-git-checks --provenance
--access public`. The CI workflow calls it on `agent-dev-env-v*` tags.
`pnpm publish-npm:canary` is the same but with `--tag canary` — CI uses it
on every push to `master` with a temporary
`<version>-canary.<run>.<sha>` version. Use the scripts everywhere; do
not run a raw `npm publish` from `packages/agent-dev-env-cli`.

### Using the in-tree CLI

After `pnpm build`, run the CLI from the repo with the root script:

```bash
pnpm agent-dev-env --help
pnpm agent-dev-env doctor            # host + tooling + disk check
pnpm agent-dev-env list              # images bundled in the package
pnpm agent-dev-env run macos         # pull, boot, wire up the sandbox
```

### Using the published CLI

End users get the same commands from npm — no repo checkout:

```bash
npx agent-dev-env run macos          # one-off
# or
npm install -g agent-dev-env
agent-dev-env run macos
```

Command surface: `run`, `stop`, `delete`, `sync`, `status`, `list`,
`build`, `deploy`, `tag`, `doctor`, `watch-build` — the full reference is
docs/cli.md, the per-platform guides are in docs/. VM state, logs, and
caches live under the `agent-dev-env` XDG roots
(`src/lib/paths.ts`): on macOS `~/Library/Application
Support/agent-dev-env/` (data), `~/Library/Logs/agent-dev-env/` (logs),
`~/Library/Caches/agent-dev-env/` (cache).

### Checks

- `pnpm check` — the full gate: `format:check`, `lint`, `typecheck`,
  `build`, `test`
- `pnpm typecheck` — TypeScript errors in production and test code
- `pnpm lint` — oxlint on `packages` + Knip unused-export analysis;
  `pnpm lint:fix` auto-fixes
- `pnpm format:check` — Prettier + Markdownlint; `pnpm format:fix`
  fixes
- `pnpm test` — Vitest unit tests (co-located `*.test.ts`);
  `pnpm test:watch` for the dev loop

## Building Images

Images are built from the recipes with the in-tree CLI (`pnpm build`
first; see docs/cli.md and DEVELOPMENT.md for the flow details):

- `pnpm agent-dev-env build <image>` — build one image (all images
  without an argument); per-platform flows stage swtpm/ISO/drivers/Fusion
  setup
- `--force` — force a rebuild (`packer -force`)
- `--no-watchdog` — skip the VNC build watchdog
- `pnpm agent-dev-env deploy <image>` — push `<version>` + `:latest` to
  GHCR (`--owner` overrides the owner)
- `packer validate -var-file=vars/<image>.pkrvars.hcl sandbox.pkr.hcl` —
  fast HCL check without a build (from `images/<platform>/`)

| Image | Build command (from the repo root) | Requires |
| --- | --- | --- |
| `sandbox-macos-tahoe` | `pnpm agent-dev-env build sandbox-macos-tahoe` | Tart + Packer |
| `sandbox-windows-11-arm64-qemu` | `WINDOWS_ISO_PATH=… pnpm agent-dev-env build sandbox-windows-11-arm64-qemu` | QEMU + swtpm + Packer + Win 11 ARM64 ISO |
| `sandbox-windows-11-arm64-vmware` | `WINDOWS_ISO_PATH=… pnpm agent-dev-env build sandbox-windows-11-arm64-vmware` | VMware Fusion 13.6+ + Packer + Win 11 ARM64 ISO |
| `sandbox-ubuntu-24-04-arm64-vmware` | `UBUNTU_ISO_PATH=… pnpm agent-dev-env build sandbox-ubuntu-24-04-arm64-vmware` | VMware Fusion 13.6+ + Packer + Ubuntu 24.04 ARM64 ISO |

All image builds need an Apple Silicon host. The ISOs are bring-your-own
(Microsoft/Canonical do not permit redistribution); the build flows
verify their SHA256 against the vars files. Full prerequisites (install
commands, disk estimates, watchdog prereqs) and how each build flow
works: DEVELOPMENT.md.

Outputs go under `<data>/build/<platform>/` — except macOS, where the
`tart` builder leaves the VM in the Tart store (`~/.tart/vms/`). The
first macOS build pulls a ~50 GB base image. `agent-dev-env doctor`
performs the whole prerequisite and disk check.

## Releases, Tags, and Changelogs

Two version tracks live in this repo. The CLI version lives in
`packages/agent-dev-env-cli/package.json` (the `agent-dev-env` npm
package; the root `package.json` is a private workspace root and is not
published). Each image version lives in its own `vars/<image>.pkrvars.hcl`
(`image_version`). They bump together in one release, but they are tagged
and recorded separately:

| | CLI (`agent-dev-env`) | Image |
| --- | --- | --- |
| Version source | `packages/agent-dev-env-cli/package.json` | `vars/<image>.pkrvars.hcl` (`image_version`) |
| Git release tag | `agent-dev-env-v<version>` | `<platform>-v<version>` (e.g. `mac-v1.2.0`, `windows-arm64-qemu-v1.1.0`) |
| Changelog | `CHANGELOG.md` (repo; `[Unreleased]` on top) | `images/<platform>/CHANGELOG.md` |
| Tag created by | CI/release automation on the CLI tag | `pnpm agent-dev-env tag <image>` |
| GHCR tags | — | `<image>:<image_version>` + `:latest` |

- `agent-dev-env tag <image>` creates and pushes the annotated
  `<platform>-v<version>` tag. It reads `image_version` from the vars
  file and enforces: clean working tree, tag not existing, and a matching
  `## [<tag>]` entry in `images/<platform>/CHANGELOG.md` — the changelog
  and the tag cannot drift. It needs a checkout of the repo (`--repo
  <path>` overrides).
- Both changelogs keep an `[Unreleased]` section on top; the tag links at
  the bottom are updated in the release change (the `[unreleased]`
  compare link moves to the new tag).
- **Canary channel:** the CI workflow publishes a canary build to npm on
  every push to `master` (after the quality gate): `publish-npm:canary`
  publishes the package with the `canary` dist-tag under a temporary
  `<version>-canary.<run>.<sha>` version (written to the CLI package for
  the publish only, never committed). Install it with
  `npm install -g agent-dev-env@canary`; it never touches the `latest`
  dist-tag.
- **CI must not publish the npm package on per-image tags.** The
  `<platform>-v<version>` tags are image releases and only drive image
  builds or nothing. `agent-dev-env` is published to npm only for a CLI
  release — from the `agent-dev-env-v<version>` tag, via the CI workflow
  (`.github/workflows/ci.yml`, npm Trusted Publishers)
  that runs the quality gate and then publishes the package and creates a
  GitHub release. Tag-prefix matching is the discriminator: never publish
  npm from a tag that is not `agent-dev-env-v*`.
- GHCR owner resolution: `GHCR_OWNER` env → `--owner` flag → git remote
  (in a checkout) → default `ameshkov` (`src/lib/ghcr.ts`). Images are
  pushed flat as `ghcr.io/<owner>/<image>` — the platform is part of the
  image name.

One release, step by step:

1. Bump `image_version` in each image's vars file and the CLI version in
   `packages/agent-dev-env-cli/package.json`.
2. Add the matching entries to `CHANGELOG.md` and
   `images/<platform>/CHANGELOG.md` and update their tag links.
3. Commit, then create the per-image tags
   (`pnpm agent-dev-env tag <image>`) and the CLI release tag
   (`agent-dev-env-v<version>`).
4. Build the images locally
   (`pnpm agent-dev-env build <image>`) and publish them
   (`pnpm agent-dev-env deploy <image>`). The CLI npm package is
   published by the CI workflow on the `agent-dev-env-v*` tag via
   `pnpm publish-npm` (or manually with the same command).

## Contribution Instructions

You MUST follow the following rules for EVERY task that you perform:

- You MUST verify it with linter, formatter, and TypeScript compiler.
  Use the following commands:
    - `pnpm typecheck` to check for TypeScript type errors
    - `pnpm lint` to run the linter (oxlint) and Knip unused-export
      analysis
    - `pnpm lint:fix` to fix linting issues that can be fixed
      automatically
    - `pnpm format:check` to check the formatting (Prettier and Markdownlint)
    - `pnpm format:fix` to fix the formatting issues

- When making changes to the project structure, ensure the Project
  Structure section in `AGENTS.md` is updated and remains valid.

- If the prompt essentially asks you to refactor or improve existing code,
  check if you can phrase it as a code guideline. If it's possible, add it
  to the relevant Code Guidelines section in `AGENTS.md`.

- You MUST update the unit tests for changed code (co-located
  `*.test.ts` files), and MUST run `pnpm test` to verify that your
  changes do not break existing functionality.

- After completing the task you MUST verify that the code you've written
  follows the Code Guidelines in this file.

- When the coding task is finished update `CHANGELOG.md` and explain
  changes in the Unreleased section. Add entries to the appropriate
  subsection (Added, Changed, or Fixed) if it already exists; do not
  create duplicate subsections. Image-recipe changes additionally land in
  the platform's `images/<platform>/CHANGELOG.md` (same format, links to
  the release tags).

## Code Guidelines

### Architecture

Universal design principles this codebase follows:

- **Separation of Concerns** — each module handles one aspect of the
  system (`lib/` foundations, `lifecycle/` image logic, `commands/`
  surface, `runners/` per-platform VM flows).
- **Single Responsibility Principle** — every file, class, or function has
  one reason to change.
- **Dependency Direction** — dependencies point downward; never from lower
  layers to higher ones. Commands may use lifecycle and lib; lifecycle may
  use lib; lib never imports commands.
- **Explicit Boundaries** — module interfaces are intentional. The CLI
  uses plain module imports (no barrel `index.ts` files): import modules
  directly by file path, never via aggregation barrels.
- **Data Flow Clarity** — data moves through a predictable path: command
  → runner/lifecycle → lib. Guest-side operations render templates from
  `assets/` with `{{TOKEN}}` substitution and report status back as
  parseable lines.
- **Minimize Coupling, Maximize Cohesion** — modules are self-contained
  and interact through narrow interfaces.
- **Make Invalid States Impossible** — use TypeScript strict mode and
  validation to prevent illegal combinations at compile time.
- **Bounded Startup Latency** — anything network-bound (image pulls,
  engine discovery, guest probes) runs with explicit retries and
  timeouts (`withTimeout`), never an unbounded wait.
- **Signal Forwarding** — long-running child processes must never be
  orphaned: the CLI forwards its own SIGINT/SIGTERM to the child it
  spawned and waits for it to exit, so a Ctrl+C during `tart push` /
  `oras push` / `packer build` / VM stops stops the child too (the
  forwarding lives in `run()`; the runner-specific handlers exist only
  where the child is spawned directly, e.g. foreground `tart run`).
- **Keep It Boring** — prefer well-understood patterns over clever or
  novel solutions. Behavior must match the shell scripts' established
  semantics (prompts, port defaults, messages) unless a deviation is
  explicitly planned.

CLI layer map:

```text
cli.ts / commands (surface)
     ↓
runners / lifecycle (per-platform flows, image logic)
     ↓
lib (path, exec, vars, template, ghcr, platform)
```

### Code Quality

All code MUST meet documentation and style requirements before merge:

- **Public API documentation**: Exported functions, classes, interfaces,
  and their properties MUST have JSDoc comments describing purpose,
  arguments, return values, and thrown errors (use `@throws` only for
  specific errors).
- **Static analysis gates**: Every change MUST pass TypeScript compilation
  (`pnpm typecheck`), oxlint (`pnpm lint`), and Prettier/Markdownlint
  (`pnpm format:check`) before merge.
- **Do not modify linter or formatter configurations**: Never change
  oxlint, Prettier, Markdownlint, or TypeScript configuration files
  (`oxlint.config.ts`, `.prettierrc`, `.prettierignore`,
  `.markdownlint-cli2.yaml`, `tsconfig*.json`) to work around lint or
  formatting errors. Fix the source code instead. If the issue cannot be
  resolved after a few attempts, ask the human for help. The only
  sanctioned deviation is the documented `knip.config.ts` `ignore` list
  and `@internal` tags for modules/exports awaiting a later port phase —
  each entry names its phase and is removed as soon as the module is used
  (Knip prints the corresponding config/tag hints).
- **oxlint category selection**: oxlint groups rules into categories
  rather than a single `recommended` preset. This project enables only the
  `correctness` category (error) plus explicit project rules
  (`no-unused-vars`, `max-lines`, `max-lines-per-function`,
  `preserve-caught-error`). The `suspicious`, `restriction`, `pedantic`,
  and `style` categories, and the `unicorn` plugin, are intentionally
  disabled: they forbid idiomatic TypeScript (async/await, optional
  chaining, object spread, `undefined`) and the project's conventions.
  Do not re-enable these without explicit justification.
- **Error handling strategy**: Prefer throwing errors over returning error
  values. Handle errors at top-level entry points where they can be
  logged (`cli.ts` maps them to a non-zero exit; `logger.die()` prints and
  exits like the shell's `die`).
- **Import style**: Use top-level static `import` statements exclusively.
  Do NOT scatter dynamic `await import()` calls inside function bodies
  ("inline imports"). When a dynamic import is genuinely necessary,
  extract it into a named, cached helper function at module scope.
- **File naming**: Use kebab-case for all file names. TypeScript source
  files MUST use lower-case kebab-case. Do NOT use PascalCase or camelCase
  file names.
- **Knip unused-export analysis**: The project uses Knip
  (`knip.config.ts`) to detect unused exports. All Knip findings MUST
  be resolved — either remove the unused export or, when the export is
  genuinely needed but not reachable through the production graph, mark it
  with the JSDoc `@internal` tag. `@internal` is allowed for
  test-only exports and for exports awaiting a later port phase; every
  `@internal` tag MUST include a short explanation of why the export is
  excluded. Do NOT use `@internal` to silence legitimate unused-export
  warnings — remove the export instead.
- **No `@public` tag**: Do NOT use the `@public` JSDoc tag. This is an
  application (CLI + recipes), not a library, so no symbol is part of a
  "public API" consumed by external consumers.
- **File size limit**: Source files MUST stay within 300 lines of code.
  This is an enforced oxlint `max-lines` gate (`'error'` severity,
  `max: 300`; blank lines and comments are skipped) — a hard gate, not a
  soft target. When a file approaches or exceeds this limit, your FIRST
  and default response MUST be to **split the file into several smaller,
  cohesive files**, each with a single, clear responsibility. For test
  files, the `max-lines` gate is raised to 500 (and
  `max-lines-per-function` is disabled); split a large `*.test.ts` into
  multiple focused `*.test.ts` files grouped by the behavior they
  verify — multiple test files per source module are explicitly allowed.
  **Do NOT** satisfy the limit by making the existing code shorter: no
  condensing tests into table-driven blocks purely to save lines, no
  shortening of identifiers, string literals, or file paths, no merging
  statements onto one line, and no removing blank lines, comments, or
  JSDoc. Formatting is managed by Prettier and must stay uniform —
  readability and clarity always win over line count.
  Exceptions: auto-generated files (the copied image/asset snapshots in
  `dist/`).
- **Function size limit**: Functions SHOULD stay within 50 lines of code.
  When approaching or exceeding this limit, break the function into
  smaller, named helper functions with single, clear responsibilities.
  **Do NOT** condense logic into dense one-liners, inline multiple
  statements on a single line, or strip whitespace to fit the limit —
  formatting is managed by Prettier and must not be sacrificed for
  brevity.

**Rationale**: Consistent documentation and tooling enforcement prevents
technical debt accumulation and ensures codebase navigability.

### Testing

Every module MUST have test coverage:

- **Test file placement**: Test files are co-located with their source
  files in `src/` and MUST use the `.test.ts` suffix (e.g.,
  `src/lib/vars.test.ts` next to `src/lib/vars.ts`).
- **Test style**: Write behavior-named `it()` descriptions (e.g. "returns
  the default owner when nothing is set"), import `describe`/`it`/`expect`
  explicitly from `vitest`, and prefer real fixtures over mocks: use
  real temp dirs (`tmpdir()` + `beforeEach`/`afterEach` cleanup) for file
  I/O, real vars files for catalog tests, and fake streams only where the
  unit under test is a stream writer (logger).
- **Shared test utilities**: Common test infrastructure lives in the
  `test/` directory when shared across modules (fixture servers, setup
  helpers). These files MUST NOT use the `.test.ts` suffix — they are
  test support code, not test cases.
- **End-to-end tests**: Full-VM/E2E tests live in `test/e2e/`. The repo
  has no CI E2E — the only end-to-end checks are full image builds (~1 hr)
  and per-phase smoke runs of the CLI against real platforms. The CI
  workflow (`.github/workflows/ci.yml`) runs the unit-test gate and, on
  `agent-dev-env-v*` tags, publishes the npm package and creates a GitHub
  release; it never builds or tests real VMs.
- **Test verification mandatory**: All changes MUST pass `pnpm test`
  before merge. Tests MUST NOT be deleted or weakened without explicit
  justification.
- **Use real integrations where practical**: Prefer integration-style
  tests that exercise real components (real vars files, real catalog
  discovery, real process spawning) over mock-heavy unit tests. Where a
  boundary cannot run in a unit test (Tart, vmrun, guest SSH), keep the
  logic in a pure function and test that.
- **Deterministic on any host**: Tests MUST NOT depend on implicit host
  state (system sockets, installed tooling, env vars). Anything read from
  the machine — e.g. the `/var/run/docker.sock` candidate in the Docker
  socket discovery — must be injectable so the suite passes on both macOS
  and GitHub's `ubuntu-latest` runners, not just the local machine.

**Rationale**: Co-locating tests with source keeps related files close;
testing against real components catches bugs that mocks hide.

### Dependency Management

- **Pin all dependency versions explicitly**: Do not use `^` or `~` in
  `package.json`.

External dependencies MUST be carefully evaluated before adoption:

- **Prefer vanilla solutions**: Use Node.js built-in APIs and standard
  language features when they adequately solve the problem. Only add a
  dependency when it provides significant value over a vanilla
  implementation.
- **Reputable sources only**: Dependencies MUST come from
  well-established, actively maintained projects. Evaluate by: weekly
  downloads, GitHub stars, recent commit activity, and known maintainers.
- **Avoid unpopular libraries**: Do NOT add niche or obscure packages
  with limited community adoption.
- **Minimize dependency count**: Each new dependency increases attack
  surface, bundle size, and maintenance burden. Justify every addition.
- **Use the latest stable version**: When adding a new dependency,
  explicitly check the package registry for the latest stable release and
  use it. Do not copy outdated version numbers from memory, training
  data, or existing lock files of other projects.

**Rationale**: Fewer, well-vetted dependencies reduce security
vulnerabilities, supply chain risks, and long-term maintenance costs.

### Configuration & Documentation

Configuration and documentation MUST stay synchronized with code:

- **Documentation updates required**: Changes to build process or
  configuration MUST update relevant documentation.
- **Structure tracking**: Changes to project structure MUST update the
  Project Structure section in `AGENTS.md`.
- **Image/recipe docs sync**: The "What's in the image" tables in
  `docs/*.md`, the layout tree in `DEVELOPMENT.md`, and the per-platform
  `images/<platform>/README.md` all describe the images — change them
  together with the recipes.
- **Versions as the single source of truth**: The image version lives in
  the image's vars file (`image_version`); the CLI version lives in
  `package.json`. Wire changes through the vars-file variables, never
  hardcode in the templates.

**Rationale**: Stale documentation causes onboarding friction and
operational incidents.

### Project Conventions

- **Image naming**: image name = vars file name = VM name
  (`sandbox-macos-<version>`, `sandbox-windows-<version>-arm64-qemu`,
  `sandbox-windows-<version>-arm64-vmware`,
  `sandbox-ubuntu-<version>-arm64-vmware`). The Xcode version is NOT part
  of the mac name. Never introduce a separate naming scheme.
- **Sandbox instances**: every platform runs sandboxes as named
  *instances* of a pristine image (`SANDBOX_VM`, default
  `default-agent-dev-env`, strict kebab-case). The pristine image cache
  (`image/`, `base/`) is shared and keyed by image only; the mutable
  working state (VMware clone, QEMU COW overlay + TPM + EFI NVRAM,
  pidfiles, `clone.json`) lives under `working/<instance>/`.
  `run`/`stop`/`delete`/`sync`/`status` all resolve the instance through
  the same env var; host bridges are keyed by role + port + instance (an
  instance on another instance's port dies with a `SANDBOX_*_PORT` hint,
  never silently reuses its bridge).
- **Releases**: the two version tracks (CLI + per-image
  `image_version`), their tags, changelogs, and the CI/npm rule are
  described in [Releases, Tags, and Changelogs](#releases-tags-and-changelogs).
- **GHCR owner resolution**: `GHCR_OWNER` env → `--owner` flag → git
  remote (in a checkout) → default `ameshkov` (`src/lib/ghcr.ts`). Images
  are pushed flat as `ghcr.io/<owner>/<image>` — the platform is part of
  the image name.
- **PowerShell assets ASCII-only**: Windows templates: inline PowerShell
  **string literals** must stay ASCII-only (the Packer WinRM transfer
  mangles non-ASCII — an em-dash once closed a string literal early and
  failed the whole build). Enforced by a unit test; em-dashes are fine in
  comments and in non-PowerShell files.
- **Guest markers**: guest-side state markers live under
  `~/.config/agent-dev-env/` (green-field policy; no legacy paths).
- **Image provenance**: every image must answer "which image is this
  sandbox from" without forensics. The guest records its identity in
  `~/.config/agent-dev-env/image.json` (baked by the Packer templates:
  image name, `image_version`, platform, base versions); the runners
  record the host-side provenance under the per-instance state root
  (`lib/provenance.ts`): `image.json` (the pulled ref + best-effort
  registry digest) and `working/<instance>/clone.json` (what the working
  VM was cloned from + when, or a `backfilled` record for VMs cloned
  before tracking). `status` and the run summaries surface both. Records
  are best-effort and never fatal; cleared with the working VM/pristine
  image.

**Rationale**: These invariants keep the CLI, recipes, and releases
consistent.

### Markdown Formatting

All Markdown files MUST follow these formatting rules:

- **Line length**: Keep lines at most 80 characters. This is not a hard
  lint gate, but SHOULD be followed for readability. Lines inside fenced
  code blocks are exempt from this limit.
- **Unordered lists**: Use dashes (`-`) for bullet points. Indent nested
  list items by 4 spaces.
- **Emphasis**: Use asterisks (`*`) for emphasis (`*italic*`,
  `**bold**`). Do NOT use underscores.
- **Headings**: Duplicate heading names are allowed only among sibling
  headings (same parent level). Avoid duplicates across different levels.
- **Inline HTML**: Avoid raw HTML in Markdown. The only allowed elements
  are `<a>`, `<p>`, `<details>`, `<summary>`, and `<img>`.
- **Trailing spaces**: Do NOT leave trailing whitespace on any line. Do
  NOT use two-space line breaks — use a blank line instead.
- **Bare URLs**: Bare URLs are permitted and do not need to be wrapped
  in angle brackets.
- **Table formatting**: Align table columns with padding when the table
  fits within 80 characters. If the table exceeds 80 characters or
  triggers an MD060 linter warning, switch to a compact format using
  single spaces only. This applies to the separator row as well — it
  should be written as `| --- |`, not `|--|`.

  Example of correct layout:

  ```markdown
  | Col1 | Col2 |
  | --- | --- |
  | Value1 | Value2 |
  ```

  Do NOT use extra padding or alignment characters beyond single spaces.

**Rationale**: Uniform Markdown formatting improves readability for both
humans and AI agents that consume project documentation.
