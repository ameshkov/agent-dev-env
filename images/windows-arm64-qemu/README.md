# Windows Sandbox Images

Windows 11 (ARM64) sandbox VM images built with [Packer](https://www.packer.io/)
and the [QEMU plugin](https://developer.hashicorp.com/packer/integrations/hashicorp/qemu)
on an Apple Silicon Mac. The output is a qcow2 disk image; the macOS host
runs it under `qemu-system-aarch64` with the HVF accelerator (near-native
performance — HVF can only virtualize ARM64 guests, so this image is
ARM64-only).

See [docs/macos.md](../../docs/macos.md) for the macOS images and
[docs/windows-qemu.md](../../docs/windows-qemu.md) for the Windows sandbox
user guide (boot it with `npx agent-dev-env run windows-qemu`).

## Prerequisites

- Apple Silicon Mac (M-series).
- [QEMU](https://www.qemu.org/): `brew install qemu` (provides
  `qemu-system-aarch64`, `qemu-img`, and the edk2 AAVMF firmware).
- [swtpm](https://github.com/stefanberger/swtpm) for the virtual TPM 2.0
  (Windows 11 system requirement): `brew install swtpm`.
- [Packer](https://www.packer.io/): `brew install hashicorp/tap/packer`
  (the QEMU plugin is installed automatically by `packer init`).
- The **Windows 11 ARM64 ISO** — bring your own, Microsoft does not permit
  redistribution:

  1. Visit [Download Windows 11 (ARM64)](https://www.microsoft.com/software-download/windows11arm64)
     and generate a download link (no Insider login required).
  2. Download the ISO (e.g. `Win11_24H2_English_Arm64.iso`, ~5 GB) and
     copy the SHA256 shown on the page into `iso_sha256` in the vars file.
  3. Set `WINDOWS_ISO_PATH` to its absolute path when building.

- **virtio-win.iso** with ARM64 drivers (release 0.1.240 or later). The
  wrapper downloads it automatically from the URL pinned in the vars file,
  or you can point `VIRTIO_WIN_ISO_PATH` at a local copy.

## How to Build

```bash
# From the repository root
WINDOWS_ISO_PATH=/path/to/Win11_24H2_English_Arm64.iso \
  npx agent-dev-env build sandbox-windows-11-arm64-qemu
```

`agent-dev-env` is the CLI shipped by this repo (see
[docs/cli.md](../../docs/cli.md)). The windows-qemu build flow:

1. Verifies the host (Apple Silicon), the tools, and the Windows ISO
   (SHA256 against `iso_sha256` from the vars file).
2. Downloads virtio-win.iso into the build cache unless
   `VIRTIO_WIN_ISO_PATH` is set.
3. Mounts virtio-win.iso and stages the ARM64 `viostor` / `vioscsi` /
   `NetKVM` driver subset into `drivers/staging/`, which Packer packs
   into the same CD as `autounattend.xml` (WinPE drive-letter
   enumeration on ARM64 is non-deterministic, so a separate drivers CD
   would be a guessing game).
4. Starts `swtpm` (TPM 2.0) and runs `packer init` + `packer build`
   with the vars file; Packer's `qemu_binary` points at
   `qemu-with-tpm.sh`, which appends the TPM/ramfb/USB/CD-ROM wiring the
   plugin's `qemuargs` option cannot express.
5. Runs a VNC **build watchdog** (bundled `assets/watchdog/`) alongside
   `packer build`: the headless boot's Enter-spam can hit "Cancel" on
   Windows Setup's "Installing Windows 11" screen, and boot races can land
   in the UEFI shell — the watchdog OCRs the VNC framebuffer (Apple
   Vision, pinned VNC port 5901) and auto-dismisses the dialog, answers
   the "Press any key" prompt, or boots the ISO from the shell. Needs
   `pip3 install vncdotool`; skipped with a warning when missing.
6. Compresses the resulting qcow2 with zstd.

A build takes roughly 30 minutes on an M-series Mac (Windows Setup itself
dominates; HVF runs the guest at near-native speed). Everything per image
lives under the CLI's data root:
`~/Library/Application Support/agent-dev-env/build/windows-qemu/output/`
(`sandbox-windows-11-arm64-qemu.qcow2`, compressed with zstd), plus
`packer_cache/` and `drivers/staging/`. The macOS/tart images build no
files and have no such directory.

## What's in the image

| Component | Detail |
| --- | --- |
| Windows 11 Pro (ARM64) | Unactivated (watermark); generic Pro key used for Setup |
| VirtIO drivers | viostor/vioscsi, NetKVM, viogpudo (virtio-gpu display — drives the runtime VM's virtio-gpu-pci) from the unattend CD; vioserial, balloon + qemu guest agent from virtio-win guest tools |
| Chocolatey | Community package manager (versions pinned in the vars file) |
| Node.js | Official win-arm64 zip from nodejs.org (version + SHA256 in the vars file) — native ARM64, no x64 emulation |
| Google Chrome | Official Windows ARM64 enterprise MSI (SHA256 in the vars file; the URL is Google's live channel — refresh the hash on Chrome releases) |
| Firefox | Official win64-aarch64 installer (version + SHA256 in the vars file) — native ARM64 |
| Python, Git, gh | Official win-arm64 builds (version + SHA256 in the vars file) — native ARM64 |
| ripgrep, jq, curl | Choco packages (no win-arm64 builds; run emulated) |
| Ninja, Git LFS | Ninja choco package (version from the vars file); Git LFS is bundled with Git for Windows, filters wired |
| pnpm, yarn | npm globals alongside the Node toolchain |
| Go | Official win-arm64 toolchain (`go<version>.windows-arm64.zip`, SHA256-pinned) — `go build` produces arm64 output |
| Vim, NuGet, make, MinGW-w64 | Choco packages (no win-arm64 builds; run emulated) |
| Rust | Via rustup (arm64 host toolchain + MSVC targets for x86_64/i686/aarch64), `rust`/`cargo` on PATH |
| JDK (Temurin) | Official Adoptium win-aarch64 zip machine `JAVA_HOME` + `bin` on PATH, verified `jni.h`/`jvm.lib` (JDK, not a JRE) — Gradle/Android/package:jni ready |
| Conan | C/C++ dependency manager, current release via pip |
| VS2022 Build Tools | Choco + `setup.exe` finalizer: .NET 4.8/.NET Core SDKs, VC++ workload (x86/x64/ARM/ARM64), ATL, CMake, Windows 11 SDK |
| WiX, protoc, NASM, LLVM | Choco packages (versions from the vars file) |
| Visual Studio Code | Native arm64 build, latest stable, direct download; `code` on PATH |
| Google Chrome | Official Windows ARM64 enterprise MSI (live channel — no version or hash pin); native arm64 |
| Firefox | Choco package (x64, runs under Prism emulation) |
| OpenCode (`@opencode/cli`, V2) | npm global |
| OpenCodeReview (`ocr`) | npm global (`@alibaba-group/open-code-review`) |
| OpenChamber web UI | 2.x (`@openchamber/web`), native service on `0.0.0.0:4000` |
| OpenChamber desktop app | 2.0.0 (win-arm64 NSIS installer, hash-pinned — see the vars file); Start Menu shortcut |
| Long paths + Developer Mode | Registry (`LongPathsEnabled`, `AllowDevelopmentWithoutDevLicense`) + `git config --system core.longpaths` |
| OpenSSH Server + RDP | Enabled; Administrator/sandbox1 (see the vars file) |
| Docker CLI | Client only (`docker` + `docker compose`), remote engine via the host bridge |
| Image identity | `%USERPROFILE%\.config\agent-dev-env\image.json` (image name + `image_version`, baked at build time) |
| Bridge tooling | Node relays (in-image `node.exe`, written by the runner) for the SSH-agent/Docker bridges — the host side is the CLI's own forwarder (no socat) |

## Versioning

Same convention as the macOS images: the image version lives in
`image_version` in the vars file; every release bumps it, adds a
`CHANGELOG.md` entry, and creates a `windows-arm64-qemu-v<version>` git
tag via `npx agent-dev-env tag <image>`.

## Running and publishing

- Run the sandbox: `npx agent-dev-env run windows-qemu` — boots the qcow2
  under QEMU + swtpm in a resizable window, forwards SSH/RDP/OpenChamber
  ports, and bridges the host's Docker engine and SSH agent into the
  guest (see [docs/windows-qemu.md](../../docs/windows-qemu.md)).
- Publish: `npx agent-dev-env deploy sandbox-windows-11-arm64-qemu` splits
  the qcow2 into 512 MiB chunks and pushes them to
  `ghcr.io/<owner>/sandbox-windows-11-arm64-qemu:<version>` + `:latest` as
  an OCI artifact via `oras` (the CLI pushes the chunks directly — no
  platform wrapper — because `tart push` only works for Tart VMs). Needs
  `brew install oras` and a GHCR token with `write:packages`
  (`oras login ghcr.io`).

## Gotchas

- **The Windows ISO is not in the repo.** The build fails fast without
  `WINDOWS_ISO_PATH`; the sha256 in the vars file protects against a
  corrupt download.
- **ARM64 only.** x86_64 Windows under QEMU on Apple Silicon runs on TCG
  (pure emulation) and is unusably slow; HVF only virtualizes ARM64.
- **virtio-win ≥ 0.1.240** is required for ARM64 driver builds; older
  releases fail at the driver-staging step.
- **No shared folder.** A host-directory mount needs the virtio-fs device,
  which fails on both sides of this ARM64 guest + Apple Silicon host pair:
  the guest side requires the ARM64 `viofs` driver, which virtio-win does
  not build (issue #1337 — the ARM64 drivers we stage are storage/network
  only), and the host side is served by `virtiofsd`, a Linux-only FUSE
  daemon. The legacy 9p device has no Windows driver at all. Use git, RDP
  clipboard, or the OpenChamber web UI to move code instead.
- **Unactivated Windows.** The image runs indefinitely with a desktop
  watermark; personalization (wallpaper) is locked.
- **`qemuargs` replaces, not appends.** Any change that needs extra qemu
  args belongs in `qemu-with-tpm.sh`, not in the template's `qemuargs`.
- **USB enumeration order is load-bearing.** The install ISO's
  usb-storage device must precede virtio-win.iso's, or EDK2 drops to the
  EFI Shell instead of booting Setup — keep the argv layout in
  `qemu-with-tpm.sh` intact.
- **Computer name ≤ 15 chars.** `win11-sandbox` fits; longer names fail
  the specialize pass even though `xmllint`/`packer validate` pass.
