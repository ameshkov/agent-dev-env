# Changelog

All notable changes to the Windows sandbox images.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The image version lives in the image's vars file (`image_version`); every
release bumps it, adds an entry below, and tags the release commit
`<platform>-v<version>` (e.g. `windows-arm64-qemu-v1.0.0`). The
`[Unreleased]` section on top is never removed — changes land there until
the next release.

## [Unreleased]

## [windows-arm64-qemu-v1.2.0] - 2026-09-06

### Added

- Toolchain parity with the AdGuard build-agent-images Windows recipes:
  Git LFS, Ninja, Temurin JDK 21 (machine `JAVA_HOME`, `bin` on PATH),
  Conan, the VS2022 ATL component, long paths + Developer Mode registry
  settings, `pnpm`/`yarn` npm globals, and the OpenChamber desktop app
  (hash-pinned win-arm64 NSIS). Go, Rust (arm64 + MSVC targets), VS2022
  Build Tools, WiX, protoc, NASM, LLVM, Vim, NuGet, MinGW-w64 and GNU
  make came with v1.1.0.
- The image records its own identity inside the guest
  (`%USERPROFILE%\.config\agent-dev-env\image.json`).
- `agent-dev-env stop` / `agent-dev-env delete` (windows-qemu) — stop
  qemu + swtpm and the host bridge listeners, and delete the state dir.
- The virtual display is now a virtio-gpu-pci at runtime: the ARM64
  `viogpudo` driver is staged onto the unattend CD, so resizing the QEMU
  window changes the guest resolution instead of only scaling the
  framebuffer (the image build itself keeps ramfb).

### Changed

- Node.js is bumped from 22 to 26.
- The image was renamed to `sandbox-windows-11-arm64-qemu` (the platform
  is now part of the name; old releases stay published under the old
  name).
- The QEMU runner boots the guest in a resizable window (`-display
  cocoa,zoom-to-fit=on` + virtio-gpu-pci).
- The build flow's EXIT trap no longer errors with `stop_watchdog:
  command not found` when a build aborts before the watchdog is defined.
- `run` recreates the working VM when the pristine image *changes*
  (path + size + mtime now recorded) and seeds the EFI NVRAM from the
  build output; the working-VM state dir moved under the CLI's data
  root.
- Run summaries point at `agent-dev-env stop` instead of manual
  `kill $(cat ...qemu.pid)` / `lsof | xargs kill` hints.

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
  runner's guest bridge setup ends on a sentinel instead of a timeout.
- The image no longer depends on the choco bootstrapper persisting the
  machine PATH; PowerShell `RemoteSigned` is baked in without aborting
  the build (the process-scope policy is set first).
- Rebuild fixes: the Node/GH CLI zip extraction paths are correct, locked
  installer temp files are retried (20 x 3 s) and waited for before
  deletion, and the OpenChamber desktop NSIS installer retries up to 3
  times on transient 0xC0000005 crashes.
- The OpenChamber web UI logon task resolves the `openchamber` shim from
  PATH instead of a hardcoded npm install dir.

## [windows-arm64-qemu-v1.1.0] - 2026-08-24

### Changed

- Build artifacts moved out of the image directory into a top-level
  `build/windows-arm64-<platform>/` directory: `output/` for
  the built qcow2, `packer_cache/` for virtio-win.iso/swtpm/watchdog
  scratch and `drivers/staging/` for the unattend CD driver subset. The
  template's `output_directory` and the staged `cd_files` path are now
  variables set by the platform `build.sh` wrapper; the macOS/tart images
  build no files and have no such directory.

### Added

- The toolchain and VS provisioners re-read PATH from the registry at
  the start of their scripts: after the tools reboot a fresh WinRM
  process can inherit a stale PATH (observed once: 'choco' not
  recognized), and the choco bootstrapper's PATH update must be picked
  up explicitly.
- The final verification checks the new toolchains with a check-and-warn
  loop instead of hard version dumps: a missing helper (e.g.
  `llvm-config`, not shipped by every LLVM Windows build) no longer
  fails the build.
- The build reboots the guest once after the virtio-win guest-tools MSI
  install (new `windows-restart` provisioner): the MSI leaves a pending
  reboot, which makes `choco install` return 3010 and makes the .NET
  Framework 4.8 Developer Pack installer fail with exit code 1 (it
  refuses to run while a reboot is pending). Choco exit-code checks in
  the VS phase accept 3010 (success, reboot required).
- Toolchains from AdGuard's `build-agent-images` Windows image
  (`windows2022-vs2022` / `windows2022-go`) that were missing: Go, Rust
  (via rustup — arm64 host toolchain + MSVC targets for
  x86_64/i686/aarch64), Visual Studio 2022 Build Tools (choco package +
  `setup.exe` finalizer: .NET 4.8/.NET Core SDKs, VC++ workload
  x86/x64/ARM/ARM64, CMake, Windows 11 SDK 22621), WiX Toolset, protoc,
  NASM, LLVM, Vim, NuGet CLI, MinGW-w64 and GNU make. All versions are
  pinned in the vars file (`go_version`, `rust_version`,
  `vs_buildtools_version`, `wixtoolset_version`, `protoc_version`,
  `nasm_version`, `llvm_version`, `vim_version`, `nuget_version`,
  `mingw_version`, `make_version`); the toolchain provisioner and the
  final verification dump their versions.
- Build watchdog: `scripts/watch-build.sh` (+ `watch-build.py` supervisor
  and `watch-build-ocr.swift` OCR helper). The headless build's
  boot-command Enter-spam can hit "Cancel" on Windows Setup's "Installing
  Windows 11" screen, and boot races can land in the UEFI shell — either
  way the build stalls until something answers. The watchdog polls the
  VNC framebuffer the Packer plugin exposes (pinned to port 5901 in the
  template), OCRs each frame with Apple Vision, and auto-dismisses the
  quit dialog (clicking "No" at the OCR'd button position), answers the
  "Press any key to boot from CD or DVD" prompt, and boots the ISO from
  the UEFI shell. `build.sh` starts it around `packer build` and stops it
  in the cleanup trap; skipped with a warning when `vncdotool` or the
  Xcode command line tools are missing. Observed during the v1.0.0 build:
  one cancel dialog dismissed, one EFI-shell boot rescued.

## [windows-arm64-qemu-v1.0.0] - 2026-08-23

### Added

- Windows 11 (ARM64) sandbox image (`sandbox-windows-11`), built with the
  Packer QEMU plugin on Apple Silicon (HVF accelerator). Windows 11 Pro
  ARM64 from the official Microsoft ISO (bring-your-own), installed
  unattended via `autounattend.xml` with swtpm-provided TPM 2.0 and edk2
  AAVMF UEFI firmware; the ARM64 virtio drivers (viostor/vioscsi/NetKVM)
  are staged into the unattend CD by `images/windows-arm64-qemu/build.sh`,
  which
  wraps `packer build` and also compresses the resulting qcow2 with zstd.
  `scripts/build.sh` now delegates to a platform's `build.sh` wrapper when
  one exists.
- The image ships: Chocolatey + toolchain (Node.js, Python, Git, GitHub
  CLI, ripgrep, jq, curl — versions pinned in the vars file), Visual
  Studio Code (native arm64), Chrome (Chrome for Testing snapshot,
  hash-pinned), Firefox, OpenCode, OpenCodeReview (`ocr`), the OpenChamber
  web UI as a native service on port 4000, OpenSSH Server + RDP, a Docker
  CLI client (remote engine via the host bridge), and the bridge tooling
  (`socat` + `npiperelay`) as utilities.
- `scripts/run-windows-qemu-sandbox.sh` — the user-facing Windows sandbox
  runner, landing together with the user guide `docs/windows-qemu.md`: boots
  the qcow2 under `qemu-system-aarch64` + swtpm (working VM = COW overlay
  with persistent TPM/NVRAM under `~/Library/Application Support/
  agent-dev-env/windows-11`), forwards SSH/RDP/WinRM/OpenChamber ports,
  re-enables Windows auto-logon (the image's `LogonCount=1` disables it
  after the OOBE boot) so the OpenChamber task fires at boot, and bridges
  the host's SSH agent and Docker engine into the guest: host-side socat
  on TCP 4200/4201 (loopback only) + guest-side Node relays serving the
  `\\.\pipe\openssh-ssh-agent` and `\\.\pipe\docker_engine` named pipes
  (started detached via a SYSTEM scheduled task — sshd's session job would
  kill in-session children). Docker context `host` is created and made the
  default.
- `images/windows-arm64-qemu/deploy.sh` — platform deploy wrapper that
  pushes the qcow2 to GHCR as an OCI artifact with `oras`
  (`ghcr.io/<owner>/sandbox-windows-11:<version>` + `:latest`);
  `scripts/deploy.sh` delegates to it like `build.sh` does (the macOS
  `tart push` flow cannot push a qcow2).
- Known limitations at this stage: no host-folder mount (the virtio-fs
  driver has no ARM64 Windows build) and Windows runs unactivated with a
  watermark. The sandbox agent rules (`scripts/agent-rules.md`) are
  macOS-flavored and not installed into Windows guests yet.

[unreleased]: https://github.com/ameshkov/agent-dev-env/compare/windows-arm64-qemu-v1.2.0...HEAD
[windows-arm64-qemu-v1.2.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/windows-arm64-qemu-v1.2.0
[windows-arm64-qemu-v1.1.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/windows-arm64-qemu-v1.1.0
[windows-arm64-qemu-v1.0.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/windows-arm64-qemu-v1.0.0
