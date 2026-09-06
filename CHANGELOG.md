# Changelog

All notable changes to the `agent-dev-env` CLI.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The CLI version lives in `packages/agent-dev-env-cli/package.json`. Image
versions are tracked separately: each lives in its image's vars file
(`image_version`) and is recorded in the per-image changelog
(`images/<platform>/CHANGELOG.md`). The `[Unreleased]` section on top is
never removed — changes land there until the next release.

## [Unreleased]

### Added

- The `agent-dev-env` CLI — the first release of the command-line tool
  that replaced the legacy shell scripts. One tool builds, runs, and
  wires up the sandbox VMs (macOS via Tart, Windows 11 ARM64 via QEMU or
  VMware Fusion, Ubuntu 24.04 ARM64 via VMware) and manages their image
  releases on GHCR:
    - `run`/`start` — starts a sandbox instance: picks or pulls the
      pristine image (local build output, then GHCR `:latest`), creates
      a named working VM per `SANDBOX_VM` (mutable state under
      `working/<instance>/`; the pristine image is shared and never
      written to), boots it, bridges the host's SSH agent and Docker
      engine into the guest, installs the guest-side agent and sandbox
      rules, copies the host user settings, and verifies OpenChamber.
    - `stop`, `delete`, `sync`, `status` — per-instance lifecycle and
      live state (image provenance, bridges, guest IP); `list` shows
      the bundled images; `doctor` checks host, tooling, and disk
      prerequisites.
    - `build`, `deploy`, `tag` — image lifecycle: Packer builds with
      per-platform staging (ISO verification, VNC build watchdog,
      VMware hardware upgrade), GHCR pushes (`tart push` / `oras
      push`), and the per-image `<platform>-v<version>` git release
      tags.
    - Four per-platform backends (macOS/Tart, Windows 11 ARM64 QEMU +
      VMware, Ubuntu VMware) with guest agents (launchd, schtasks,
      systemd), host user-settings copy, and bridge transports.
    - XDG-aware state, logs, and caches under the `agent-dev-env`
      roots; image provenance records (`image.json` + `clone.json`); and
      signal forwarding so Ctrl+C stops spawned `packer` / `tart` /
      `oras` children.
- Spawned child processes never inherit git's hook environment
  (`GIT_DIR`, `GIT_INDEX_FILE`, ...), so `git` calls that select their
  repo with `-C` stay on the target repo even when the CLI itself runs
  inside a git hook.
