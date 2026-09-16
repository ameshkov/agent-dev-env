# Changelog

All notable changes to the Windows sandbox images (VMware).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The image version lives in the image's vars file (`image_version`); every
release bumps it, adds an entry below, and tags the release commit
`<platform>-v<version>` (e.g. `windows-arm64-vmware-v1.0.0`). The
`[Unreleased]` section on top is never removed — changes land there until
the next release.

## [Unreleased]

## [windows-arm64-vmware-v1.1.1] - 2026-09-16

### Fixed

- The image no longer pins a SHA256 for the Google Chrome enterprise
  MSI: the URL is Google's live, unversioned ARM64 channel (Chrome for
  Testing publishes no win-arm64 build), so the pinned hash went stale
  with every Chrome release and failed the build at the Chrome install
  step. Chrome installs whatever build the channel serves, like the
  macOS recipe (Homebrew cask).

## [windows-arm64-vmware-v1.1.0] - 2026-09-06

### Added

- Toolchain parity with the AdGuard build-agent-images Windows recipes:
  Git LFS, Ninja, Temurin JDK 21 (machine `JAVA_HOME`, `bin` on PATH),
  Conan, the VS2022 ATL component, long paths + Developer Mode registry
  settings, `pnpm`/`yarn` npm globals, the OpenChamber desktop app
  (hash-pinned win-arm64 NSIS), and the previously missing toolchains —
  Go, Rust (arm64 + MSVC targets), VS2022 Build Tools, WiX, protoc, NASM,
  LLVM, Vim, NuGet, MinGW-w64 and GNU make (all pinned in the vars file).
- The image records its own identity inside the guest
  (`%USERPROFILE%\.config\agent-dev-env\image.json`).
- `agent-dev-env stop` / `agent-dev-env delete` (windows-vmware) — stop
  the working VM plus the host bridge listeners, and delete the state
  dir.
- Build hardening: the toolchain and VS provisioners re-read PATH from
  the registry, the final verification is a check-and-warn loop instead
  of hard version dumps, and the build reboots once after the VMware
  Tools install (pending-reboot failures like choco 3010 are gone).

### Changed

- Node.js is bumped from 22 to 26.
- The image was renamed to `sandbox-windows-11-arm64-vmware` (the
  platform is now part of the name; old releases stay published under
  the old name).
- Build artifacts moved to the top-level `build/windows-arm64-vmware/`
  dir; the artifact is upgraded post-build with `vmrun upgradevm`, and
  `run` upgrades its working clone the same way (once per clone).
- The guest-side bridge scripts moved into the bundled
  `guest-agent-windows` agent; the working-VM state dir moved under the
  CLI's data root; the working clone gets a distinct display name.
- Run summaries point at `agent-dev-env stop` instead of manual
  `vmrun stop` / `lsof kill` hints; HGFS is reported as unsupported for
  Windows 11 ARM guests (`--work-dir` is a no-op with a warning).

### Fixed

- Node.js, gh, Git, Python, Go, the Temurin JDK, Firefox and Chrome are
  now the official win-arm64 builds — the x64 (choco) ones ran emulated
  and opencode's native session crashed with 0xC0000005 (the remaining
  x64-only tools still run emulated by necessity).
- The OpenChamber desktop provisioner: `-and` no longer mis-parses as a
  parameter, the installer search walks every per-user/per-machine root
  plus the uninstall registry, and the exe search polls for a few
  seconds.
- The choco `git-lfs` package is gone (Git bundles its own); the machine
  PATH dedup no longer double-appends choco dirs; `ocr` is verified
  pinned before the build finishes.
- The JDK provisioner refreshes `$env:Path` from the registry; the
  runner's guest bridge setup ends on a sentinel instead of a 5-min
  timeout.
- The shared host directory waits for VMware Tools (`checkToolsState`)
  before registering; the image no longer depends on the choco
  bootstrapper persisting the machine PATH.
- PowerShell `RemoteSigned` is baked in without aborting the build (the
  process-scope policy is set first).
- VMware Tools now actually run in the image: the 'VMware Tools' service
  is registered and started by the final verification (the first
  attempt via `autounattend.xml` broke Windows Setup, so it moved to a
  provisioner).
- Rebuild fixes: the Node/GH CLI zip extraction paths are correct, locked
  installer temp files are retried (20 x 3 s) and waited for before
  deletion, and the OpenChamber desktop NSIS installer retries up to 3
  times on transient 0xC0000005 crashes.
- The VNC watchdog clicks "No" on Windows Setup's upgrade dialog itself.
- The OpenChamber web UI logon task resolves the `openchamber` shim from
  PATH instead of a hardcoded npm install dir.

## [windows-arm64-vmware-v1.0.0] - 2026-08-23

### Added

- Windows 11 (ARM64) VMware sandbox image (`sandbox-windows-11-vmware`),
  built with the Packer vmware-iso plugin on Apple Silicon (VMware Fusion
  hosts the installer — the most proven Windows-ARM path; Fusion provides
  the ARM64 vmxnet3 NIC driver, the ARM64 VMware Tools and NVMe storage
  with the in-box driver). Windows 11 Pro ARM64 from the official
  Microsoft ISO (bring-your-own; the same 25H2 ISO checksum the QEMU
  image pins), installed unattended via `autounattend.xml` with the
  Windows-11 hardware-check bypasses (BypassCPUCheck is mandatory —
  Apple Silicon) and OOBE bypasses. The build stages the vmxnet3 driver
  from Fusion's `Contents/Library/isoimages/arm64/drivers-arm64.zip` into
  the unattend CD (no in-box VMware NIC driver: it must land before any
  network use) and installs Fusion's ARM64 tools ISO (attached by the
  builder, `tools_mode "attach"`; installed by `autounattend.xml` at
  first logon, before WinRM — the tools installer rebinds the NIC and
  kills any live WinRM session (a provisioner-based install timed out).
- The image ships the same toolchain as the QEMU image: Chocolatey +
  toolchain (Node.js, Python, Git, GitHub CLI, ripgrep, jq, curl —
  versions pinned in the vars file), Visual Studio Code (native arm64),
  Chrome (Chrome for Testing snapshot, hash-pinned), Firefox, OpenCode,
  OpenCodeReview (`ocr`), the OpenChamber web UI as a native service on
  port 4000, VMware Tools, OpenSSH Server + RDP, a Docker CLI client
  (remote engine via the host bridge), and the bridge tooling
  (`socat` + `npiperelay`) as utilities.
- `images/windows-arm64-vmware/build.sh` — platform build wrapper:
  verifies the host + Fusion install + ISO sha256, stages the vmxnet3
  driver, starts the VNC build watchdog (shared `scripts/watch-build.sh`),
  and runs `packer init` + `packer build`.
- `images/windows-arm64-vmware/deploy.sh` — platform deploy wrapper that
  packs the output directory (vmx + vmdk + nvram) into a tar.gz and
  pushes it to GHCR as an OCI artifact with `oras`
  (`ghcr.io/<owner>/sandbox-windows-11-vmware:<version>` + `:latest`);
  `scripts/deploy.sh` delegates to it like it does for the QEMU image.
- `scripts/run-windows-vmware-sandbox.sh` — the user-facing VMware sandbox
  runner, landing together with the user guide `docs/windows-vmware.md`:
  extracts the archive into the state dir and clones a working VM with
  `vmrun -T fusion clone ... full` (base never written to) under
  `~/Library/Application Support/agent-dev-env/windows-11-vmware`, boots
  it with `vmrun start`, discovers the guest IP via `vmrun
  getGuestIPAddress` (VMware Tools are in the image — no port
  forwarding, the host is the NAT router for the vmnet8 subnet),
  re-enables Windows auto-logon (the image's `LogonCount=1` disables it
  after the OOBE boot) so the OpenChamber task fires at boot, bridges the
  host's SSH agent and Docker engine into the guest (host-side socat on
  TCP 4200/4201 bound to the vmnet8 address + guest-side Node relays
  serving the `\\.\pipe\openssh-ssh-agent` and `\\.\pipe\docker_engine`
  named pipes, started detached via a SYSTEM scheduled task), optionally
  shares a host directory (HGFS, `--work-dir`), and verifies OpenChamber.
- Known limitations at this stage: Windows runs unactivated with a
  watermark; the sandbox agent rules (`scripts/agent-rules.md`) are
  macOS-flavored and not installed into Windows guests yet; the shared
  folder is best-effort (HGFS must be enabled by VMware Tools).

[unreleased]: https://github.com/ameshkov/agent-dev-env/compare/windows-arm64-vmware-v1.1.1...HEAD
[windows-arm64-vmware-v1.1.1]: https://github.com/ameshkov/agent-dev-env/releases/tag/windows-arm64-vmware-v1.1.1
[windows-arm64-vmware-v1.1.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/windows-arm64-vmware-v1.1.0
[windows-arm64-vmware-v1.0.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/windows-arm64-vmware-v1.0.0
