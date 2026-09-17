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

## [0.3.1] - 2026-09-17

### Changed

- The image-size estimates shown in pull prompts, the macOS
  pristine-delete prompt, and the `doctor` disk check now match the
  published images: one-time downloads of ~77 GB (macOS), ~25 GB
  (Windows QEMU), ~23 GB (Windows VMware), and ~8.5 GB (Ubuntu VMware),
  and the `doctor` build overhead reflects the ~70 GB macOS base image.

## [0.3.0] - 2026-09-17

### Changed

- Image artifacts are now published and pulled as fixed-size 512 MiB
  chunks (one OCI layer per chunk, media type
  `application/vnd.agent-dev-env.image-part`) instead of one multi-GB
  layer. GHCR's signed blob URL expires a few minutes after it is
  issued, so the old 22 GiB single layer was systematically cut about a
  third of the way through and every retry restarted from zero. The
  chunked pull fetches each layer with `oras blob fetch`, keeps the
  chunks already on disk and re-fetches only the missing or truncated
  ones — an interrupted pull resumes at chunk granularity instead of
  restarting the image. `deploy` splits the built archive before
  pushing (VMware/Ubuntu: tar.gz, QEMU: qcow2; QEMU's staging chunks are
  removed after a successful push) and records the chunk list in
  `parts.json` next to them. The pristine-image identity is now the
  pulled manifest digest (for locally packed images, a hash of the
  chunk digests). Documented in AGENTS.md and docs/cli.md.
- `UBUNTU_VMWARE_IMAGE` / `WINDOWS_VMWARE_IMAGE` now accept a chunked
  image directory (`part-NNNN` files + `parts.json`) or a local tar.gz,
  which is split into cached chunks next to it on first use; the
  documented golden-image workflow is unchanged command-wise. A local
  `WINDOWS_IMAGE` override still takes a qcow2.
- Chunked transfers now retry transient failures with bounded
  exponential backoff (`lib/retry.ts`): each `oras blob fetch` gets up
  to four attempts, the manifest fetches three, and `oras push` /
  `tart push` / `tart pull` three each. An expired signed URL or a
  dropped connection costs one attempt, not the transfer, and completed
  chunks stay on disk for the next run. A command interrupted by Ctrl+C
  (SIGINT/SIGTERM, or the conventional 130/143 exits) is never retried.

### Removed

- Single-layer image manifest support: pulling an image published before
  the chunked layout fails with an actionable error
  (`rebuild the image and push it again with the chunked layout`).
  Images must be re-deployed before the new CLI can pull them. A
  leftover single-file VM cache is removed after the first successful
  chunked pull.

### Fixed

- The large-image pull no longer fails with the misleading
  `oras pull failed — check your network connection (public GHCR images
  pull without a login)` error and no longer leaves a truncated cache
  that later runs trust: chunk failures are reported with the failing
  chunk, and the completed chunks are kept for the retry. `run` no
  longer trusts a partially assembled QEMU disk — the pristine qcow2
  carries a verified marker written only after the assembly size checks
  out.

## [0.2.0] - 2026-09-17

### Added

- The Windows settings copy (`run` and `sync` on `windows-qemu` /
  `windows-vmware`) now offers a guest reboot after it wrote a user-scope
  environment variable (`OPENCODE_MODELS_URL`). Windows applies such a
  variable only to processes started afterwards, so without the reboot
  OpenChamber and opencode can keep the old environment. The offer
  defaults to yes; `--yes` accepts it without a prompt.
- `delete <platform> --pristine` now works for the QEMU and VMware
  backends too (it was accepted but ignored outside macOS): it drops the
  shared pristine image cache — the pulled image, the extracted base and
  the provenance record — including when no instance state is left to
  delete, so an interrupted first pull no longer leaves a truncated cache
  that every later run trusts and fails on. While another instance
  remains the cache is kept (a QEMU working disk is a COW overlay backed
  by the pristine qcow2, and a VMware re-clone needs the cache) and the
  command says so; the delete summary now always reports whether the
  cache was removed or where it was kept.

### Fixed

- The Windows guest-reboot waits no longer return against the
  still-running pre-reboot guest. A reboot request (`shutdown /r /t 0`)
  leaves the old sshd answering for a few seconds, so the "wait for the
  guest to reboot" poll succeeded immediately and the run proceeded into
  the actual shutdown window — after the auto-logon reboot `run
  windows-vmware` then died at step 3 with ssh2's `Not connected`, and a
  guest that came back on a new NAT IP was polled at its old address. The
  runner now waits for the guest to stop answering first (two consecutive
  failed probes), then refreshes the target (the VMware IP via `vmrun
  getGuestIPAddress`, unchanged for QEMU), then waits for sshd to come
  back (`runners/windows-reboot.ts`, shared by both backends' auto-logon
  and settings reboots and by `sync`).
- Windows image builds no longer fail on a stale Chrome hash: the
  recipes stopped pinning the Google Chrome enterprise MSI, whose URL is
  a live, unversioned ARM64 channel (Chrome for Testing ships no
  win-arm64 build). The images install whatever build the channel
  serves, like the macOS recipe (Homebrew cask).

## [0.1.1] - 2026-09-06

### Fixed

- `run macos` no longer fails with `the specified VM "<image>" does not
  exist` right after a first-time image pull. On current Tart versions
  `tart pull` stages the image in the local OCI store under its full
  registry reference (`ghcr.io/<owner>/<image>:latest`) — the bare short
  name never appears in `tart list` — so the runner now detects the pulled
  image by that stored reference and clones the working VM from it
  (falling back to a local VM name when the image was imported locally,
  and to the pull reference for an image that is not present yet).
- The published npm package now ships the repo README. The package-root
  `README.md` is a generated, gitignored file (copied from the repo root
  by `copy-assets.mjs`), so publishing without a build step first — e.g.
  a raw `pnpm publish` from a fresh checkout — produced a tarball with no
  README. The CLI package's `prepublishOnly` hook now runs the build on
  every publish, so any publish path ships `dist/`, the assets, and the
  README.

## [0.1.0] - 2026-09-06

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

[unreleased]: https://github.com/ameshkov/agent-dev-env/compare/agent-dev-env-v0.3.1...HEAD
[0.3.1]: https://github.com/ameshkov/agent-dev-env/releases/tag/agent-dev-env-v0.3.1
[0.3.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/agent-dev-env-v0.3.0
[0.2.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/agent-dev-env-v0.2.0
[0.1.1]: https://github.com/ameshkov/agent-dev-env/releases/tag/agent-dev-env-v0.1.1
[0.1.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/agent-dev-env-v0.1.0
