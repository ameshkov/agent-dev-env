# Changelog

All notable changes to the macOS sandbox images.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The image version lives in the image's vars file (`image_version`); every
release bumps it, adds an entry below, and tags the release commit
`<platform>-v<version>` (e.g. `mac-v1.2.0`). The `[Unreleased]` section on top
is never removed — changes land there until the next release.

## [Unreleased]

## [mac-v1.9.0] - 2026-09-25

### Changed

- OpenCode is now V2, installed from the tap's `opencode-v2` formula
  (`brew install anomalyco/tap/opencode-v2`; the plain `opencode`
  formula still installs V1 and conflicts with it). The OpenChamber web
  UI and desktop app move to the 2.x line — the release compatible with
  OpenCode V2.
- The user-settings copy now includes the OpenCode V2 terminal config
  (`~/.config/opencode/cli.json`), so the guest's terminal preferences
  match the host's. The settings version was bumped so existing guests
  are offered the re-copy once.

## [mac-v1.8.0] - 2026-09-06

### Added

- Dev toolchain parity with the AdGuard build-agent-images mac recipe:
  CMake, Ninja, Go, `rbenv`, `xcodegen`/`swiftlint`/`periphery`, `pnpm`
  and `yarn`; Rust via rustup (pinned); Java via SDKMAN; Flutter pinned
  to the base image's `$FLUTTER_HOME`; Gradle + Kotlin/Native pre-caches;
  Android SDK extras; Git LFS, legacy `ssh-rsa` and the CocoaPods
  `insteadOf` block; and an Xcode/simulator warm-up. The optional
  toolchains are empty-by-default vars pinned in
  `vars/sandbox-macos-tahoe.pkrvars.hcl`.
- The image records its own identity inside the guest
  (`~/.config/agent-dev-env/image.json`).
- `agent-dev-env stop` / `agent-dev-env delete` (macos) — stop the
  sandbox VM plus the host bridge listeners, and delete the working VM
  (and the pristine image with `--pristine`).
- `agent-dev-env run` (macos) now installs the sandbox environment rules
  into the guest's coding agents (opencode `AGENTS.md`, Copilot CLI
  `copilot-instructions.md`), with the work-dir and mount paths
  substituted at install time.

### Changed

- The base image is now `ghcr.io/cirruslabs/macos-tahoe-xcode:26.5`
  (Xcode 26.5), the latest stable Xcode image for macOS Tahoe.
- The run summary's stop hints point at `agent-dev-env stop` instead of a
  bare `tart stop` and a hand-written `lsof | xargs kill`.

### Fixed

- The baked `image.json` now contains the interpolated image name /
  `image_version` / Xcode version, not the literal `${var.*}` text (the
  heredoc used a quoted delimiter).
- The SSH agent and Docker bridge setups no longer skip when `tart ip`
  fails right after boot — the IP is now retried (5 x 2 s) through a
  shared helper.

## [mac-v1.6.0] - 2026-08-20

### Added

- OpenCodeReview — the AI-powered code review CLI
  (https://github.com/alibaba/open-code-review), installed globally via npm
  (`@alibaba-group/open-code-review`, provides the `ocr` command).

### Changed

- The user-settings copy now includes the OpenCodeReview config
  (`~/.opencodereview/config.json`), so the guest's `ocr` CLI uses the same
  LLM provider and model as the host. The settings version was bumped so
  existing guests are offered the re-copy once.
- The `.gitconfig` sanitization in the user-settings copy now rewrites
  paths under the host's home directory to the guest's home directory
  (`/Users/admin`) instead of `~`, and no longer drops `program` values —
  the absolute path works even for values git execs verbatim, so a
  home-relative signing wrapper (e.g. `gpg.ssh.program`) survives the
  copy. The settings version was bumped so existing guests are offered the
  re-copy once.
- The Docker bridge in `scripts/run-macos-sandbox.sh` now also exports
  `DOCKER_HOST` and `TESTCONTAINERS_HOST_OVERRIDE` in the guest's
  `~/.zprofile`, so container-based test frameworks (testcontainers and
  similar) work in the guest out of the box: the Ryuk reaper and published
  ports are reached on the host engine via the NAT gateway instead of the
  guest's `localhost`. Guests set up before this change get the exports the
  next time the runner runs (each `~/.zprofile` block is guarded by its own
  marker, so the socat block is not duplicated).

## [mac-v1.5.0] - 2026-08-20

### Changed

- Windowed runs of `scripts/run-macos-sandbox.sh` now pass Tart's
  `--capture-system-keys` flag by default, so system shortcuts (Cmd+Space,
  Cmd+Tab, ...) go to the guest while the VM window is focused instead of
  being handled by the host. Headless runs are unaffected.
- The user-settings copy now includes the mcp-compress-router settings
  (`~/Library/Application Support/mcp-compress-router/`): the MCP server
  config (`mcp.json`) with its endpoints and credentials, the stored
  credentials, and the tool-schema cache, so the guest's opencode sessions
  can use the same MCP servers. The settings version was bumped so existing
  guests are offered the re-copy once.
- The OpenChamber web UI now listens on port 4000 instead of 3000 — 3000 is
  the default Vite dev-server port, so frontend dev servers in the guest no
  longer collide with it. The guest port is now a Packer variable
  (`openchamber_port` in the vars file), and the runner's
  `SANDBOX_OPENCHAMBER_PORT` default was bumped to match.

## [mac-v1.4.0] - 2026-08-19

### Added

- Sublime Text (current stable build, Homebrew cask `sublime-text`) with the
  `subl` CLI; the quarantine attribute is stripped so it launches without
  Gatekeeper prompts.
- The OpenChamber native macOS desktop app
  (`/Applications/OpenChamber.app`, Homebrew cask `openchamber`), installed
  alongside the web UI for working inside the guest desktop; the quarantine
  attribute is stripped so it launches without Gatekeeper prompts. The app
  bundles its own OpenCode CLI and manages its own server by default —
  `docs/macos.md` explains how to pair it with the web UI service on port
  3000 so both share sessions.
- New `scripts/sync-macos-sandbox.sh`: copies the host's user settings into
  the guest on demand (no VM restart needed), updates the versioned marker
  so the runner won't re-offer the copy, and restarts OpenChamber. Requires
  a running VM; pass `--yes` to skip the confirmation prompt.
- Docker CLI (`docker` formula) with the `docker compose` and `docker buildx`
  plugins (Homebrew `docker-compose`/`docker-buildx`, discovered via
  `cliPluginsExtraDirs` in `~/.docker/config.json`). Client only: the sandbox
  is a macOS VM, and Apple's Virtualization.framework doesn't support nested
  virtualization for macOS guests, so no container engine (Docker Desktop,
  Colima, ...) can run inside it — `docs/macos.md` explains how to point the
  CLI at a remote engine, e.g. the host's Docker Desktop over SSH.
- `scripts/run-macos-sandbox.sh` now bridges the host's Docker engine into
  the guest, mirroring the SSH agent bridge: it detects an engine socket on
  the host (Docker Desktop, Colima, OrbStack, `/var/run/docker.sock`), serves
  it over a host-side `socat` TCP listener for the current run, persists a
  guest-side `socat` in the guest's `~/.zprofile` that recreates
  `~/.docker/run/docker.sock` on every login, and creates the docker context
  `host` in the guest so `docker`/`docker compose`/`docker buildx` use the
  host engine. `--no-docker` skips the bridge; `SANDBOX_DOCKER_PORT`
  overrides the bridge port (default `4101`).

### Changed

- The user-settings copy now sanitizes `.gitconfig` for the guest, where the
  user differs (the image's `admin` vs. the host login): paths under the
  host's home directory are rewritten to `~` (git expands `~` for path-like
  keys and the shell does for `core.sshCommand`), and `program = ~/...`
  values are dropped — git execs program values verbatim, and the
  `gpg.ssh.program` signing wrapper is a host-only workaround; the guest
  signs through the bridged SSH agent instead. The settings version was
  bumped so existing guests are offered the re-copy once.
- The user-settings copy (runner and the new sync script) now covers the
  whole global opencode config directory: `opencode.json`/`.jsonc`,
  `tui.json`/`.jsonc`, and the `agents/`, `commands/`, `modes/`, `plugins/`,
  `skills/`, `tools/` and `themes/` directories, plus the config dir's
  `package.json`/lockfiles for local plugin dependencies (npm plugins are
  auto-installed by opencode at startup, so `node_modules` stays on the
  host). The settings version was bumped so existing guests are offered the
  re-copy once. The copy logic was extracted into
  `scripts/lib/macos-settings.sh`, shared by `scripts/run-macos-sandbox.sh`
  and `scripts/sync-macos-sandbox.sh`.
- The user-settings copy now includes the Copilot CLI config and skills
  (`~/.copilot/config.json` and `~/.copilot/skills/`); machine-specific
  `~/.copilot/logs`/`ide` are skipped. Copilot auth is not copied — it lives
  in the macOS Keychain, so the guest signs in once. The settings version
  was bumped so existing guests are offered the re-copy once.
- The user-settings copy now includes the installed VS Code extensions
  (`~/.vscode/extensions/`), so they don't have to be reinstalled in the
  guest, and the user-authored VS Code config (`settings.json`,
  `keybindings.json` and `snippets/` under
  `~/Library/Application Support/Code/User/`), which carries per-extension
  settings. Extension auth and machine-specific state are not copied —
  keychain-stored tokens (Copilot, GitHub, ...) don't travel with files, so
  those extensions ask to sign in once in the guest, and the `globalStorage`/
  `workspaceStorage` caches stay on the host. The settings version was bumped
  so existing guests are offered the re-copy once.
- `scripts/run-macos-sandbox.sh` now runs the VM in the background by
  default: `tart run` is nohup'd to
  `~/Library/Logs/agent-dev-env/tart-<vm>.log` and the script exits after
  the summary while the VM keeps running (`tart stop <vm>` to stop it). Pass
  `--foreground` to keep the terminal attached and block until the VM stops,
  as before. When the VM is already running, the script now asks whether to
  restart it instead of silently reusing it.

## [mac-v1.3.0] - 2026-08-19

### Added

- `scripts/run-macos-sandbox.sh` now offers to copy the host's user settings
  into the guest — opencode config (`~/.config/opencode/opencode.json` /
  `.jsonc`) and auth (`~/.local/share/opencode/auth.json`), plus
  `~/.ssh/allowed_signers`, `~/.ssh/known_hosts`, `~/.ssh/*.sh` and
  `~/.gitconfig` — once per VM, tracked by a versioned marker inside the
  guest (`~/.config/agent-dev-env/settings-copied`); bumping the settings
  version in the script re-copies when new settings are added. Skip with
  `--no-settings`.
- The guest's `~/.ssh/config` now pins `IdentityAgent /tmp/ssh-agent.sock`
  for all hosts, so `ssh` works through the bridged host agent even where
  `SSH_AUTH_SOCK` is not exported (`tart exec`, cron, launchd jobs, GUI
  tools). Applied idempotently on every run; guests set up before this patch
  get it too.

### Changed

- The template's `disk_size` default is now 160 GB (matching the vars files
  and the built images) — the previous 80 GB default was below the ~140 GB
  Cirrus base image disk, and tart can only grow a disk, never shrink it. No
  effect on released images; only relevant when a vars file omits `disk_size`.
- `scripts/deploy.sh` pushes in 3 MB chunks (`tart push --chunk-size 3`)
  because GHCR only accepts upload chunks smaller than 4 MB.

## [mac-v1.2.0] - 2026-08-19

### Added

- Google Chrome and Mozilla Firefox (latest stable universal macOS builds)
  installed via Homebrew casks; the quarantine attribute is stripped so they
  launch without Gatekeeper prompts — the VM boots straight to the desktop
  and may run headless.

### Changed

- The OpenChamber LaunchAgent now runs the exact `opencode` binary the image
  ships: the build resolves `command -v opencode` and pins the absolute path
  via `OPENCODE_BINARY` before `openchamber startup enable` snapshots the
  environment, instead of relying on PATH lookup in the login session.
  Rebuilding the image is required for this to take effect.
- The sandbox runs with no audio pass-through with the host: builds pass
  `--no-audio` to Tart, and the docs recommend `tart run --no-audio` so the
  guest can't record from the host's microphone or play sound on the host's
  speakers. No image content change — audio sharing is a runtime Tart flag,
  so existing images are unaffected.

## [mac-v1.1.0] - 2026-08-19

### Added

- OpenChamber (web UI for OpenCode, https://openchamber.dev) installed via
  `@openchamber/web` and registered as a login service (LaunchAgent) that
  listens on `0.0.0.0:3000`, so the host can open the UI at
  `http://<vm-ip>:3000`. The UI is password-protected
  (`openchamber_ui_password` in the vars file, default `sandbox`); see
  `docs/macos.md` for host access and how to change the password.

## [mac-v1.0.0] - 2026-08-19

First versioned release of the `sandbox-macos-tahoe` image (macOS 26 Tahoe +
Xcode 26.4.1).

### Added

- System setup: auto-login as `admin`/`admin`, Remote Login (SSH), Screen
  Sharing (VNC), friendly hostname, Tart Guest Agent check.
- Homebrew toolchain: `bash`, `git`, `gh`, `jq`, `ripgrep`, `coreutils`,
  `curl`, `wget`, `socat`, `nvm`, `python@3.14`, `ruby`.
- Node.js 26 installed via nvm (default version, includes npm).
- Unversioned `python`/`pip` aliases pointing at `python@3.14`.
- Visual Studio Code (latest stable) with the `code` CLI on PATH.
- OpenCode (AI coding agent) via the anomalyco Homebrew tap.

[unreleased]: https://github.com/ameshkov/agent-dev-env/compare/mac-v1.9.0...HEAD
[mac-v1.9.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.9.0
[mac-v1.8.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.8.0
[mac-v1.6.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.6.0
[mac-v1.5.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.5.0
[mac-v1.4.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.4.0
[mac-v1.3.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.3.0
[mac-v1.2.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.2.0
[mac-v1.1.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.1.0
[mac-v1.0.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/mac-v1.0.0
