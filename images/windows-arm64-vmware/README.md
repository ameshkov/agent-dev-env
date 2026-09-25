# Windows Sandbox Images — VMware

Windows 11 (ARM64) sandbox VM images built with [Packer](https://www.packer.io/)
and the [VMware plugin](https://github.com/vmware/packer-plugin-vmware)
(`vmware-iso` builder) on an Apple Silicon Mac. The output is a runnable
vmx + vmdk VM (built at the vmware-iso hardware level, upgraded post-build
to the host Fusion's current hardware version — see
[How to Build](#how-to-build)), packed into a tar.gz for publishing; the
macOS host runs it under Fusion's `vmrun` CLI. Fusion
virtualizes ARM64 guests natively and is the most proven Windows-ARM path —
it also ships the ARM64 boot drivers and the ARM64 VMware Tools (guest IP
discovery works, but HGFS shared folders are not supported for Windows 11
ARM guests on Apple silicon — see
[docs/windows-vmware.md](../../docs/windows-vmware.md)).

This is the VMware sibling of the
[QEMU-based image](../windows-arm64-qemu/README.md): same Windows 11 Pro
ARM64 guest, same toolchain, same credentials. See
[docs/windows-vmware.md](../../docs/windows-vmware.md) for the user guide
(boot it with `npx agent-dev-env run windows-vmware`) and
[docs/windows-qemu.md](../../docs/windows-qemu.md) for the QEMU variant.

## Prerequisites

- Apple Silicon Mac (M-series). Fusion cannot virtualize ARM64 guests on
  Intel, so this image is ARM64-only.
- [VMware Fusion](https://www.vmware.com/products/desktop-hypervisor/workstation-and-fusion)
  (free for personal use; the Packer plugin requires Fusion 13.6+).
- [Packer](https://www.packer.io/): `brew install hashicorp/tap/packer`
  (the VMware plugin is installed automatically by `packer init`).
- The **Windows 11 ARM64 ISO** — bring your own, Microsoft does not permit
  redistribution:

  1. Visit [Download Windows 11 (ARM64)](https://www.microsoft.com/software-download/windows11arm64)
     and generate a download link (no Insider login required).
  2. Download the ISO (e.g. `Win11_25H2_English_Arm64_v2.iso`, ~7.5 GB) and
     copy the SHA256 shown on the page into `iso_sha256` in the vars file.
  3. Set `WINDOWS_ISO_PATH` to its absolute path when building.

No driver or tool disk is needed beyond Fusion itself: the ARM64 vmxnet3
NIC driver comes from Fusion's
`Contents/Library/isoimages/arm64/drivers-arm64.zip` and the ARM64 VMware
Tools ISO from `Contents/Library/isoimages/arm64/windows.iso` (same app
bundle; `FUSION_APP_PATH` overrides a non-standard install).

## How to Build

```bash
# From the repository root
WINDOWS_ISO_PATH=/path/to/Win11_25H2_English_Arm64_v2.iso \
  npx agent-dev-env build sandbox-windows-11-arm64-vmware
```

`agent-dev-env` is the CLI shipped by this repo (see
[docs/cli.md](../../docs/cli.md)). The windows-vmware build flow:

1. Verifies the host (Apple Silicon), the tools, the Fusion install (must
   ship the ARM64 drivers zip and tools ISO), and the Windows ISO (SHA256
   against `iso_sha256` from the vars file).
2. Stages the ARM64 `vmxnet3` driver (inf/sys/cat) into
   `drivers/staging/` at the root of the unattend CD — Windows 11 ARM64
   has no in-box VMware NIC driver, and it must land before any network
   use (WinRM from the host).
3. Runs `packer init` + `packer build` with the vars file; the template
   attaches Fusion's ARM64 tools ISO (`tools_mode "attach"`) and
   `autounattend.xml` installs it at first logon (before WinRM comes up —
   the tools installer rebinds the NIC and would kill a live WinRM
   session).
4. Runs the VNC **build watchdog** (bundled `assets/watchdog/`) alongside
   `packer build` (pinned VNC port 5901) to auto-dismiss Windows Setup
   dialogs and rescue a boot that lands in the UEFI shell. Needs
   `pip3 install vncdotool` + Xcode command line tools; skipped with a
   warning when missing.
5. Upgrades the output VM with `vmrun upgradevm` to the hardware version
   the installed Fusion writes for a new VM (hardware version 20 → 22 on
   Fusion 26). The headless build never shows Fusion's one-time
   "Upgrade this virtual machine?" prompt, but a first GUI start of a
   version-20 VM would; the upgrade also rewrites the vmdk descriptor.
   The runner upgrades its working clone the same way for artifacts built
   by older Fusion versions (see
   [docs/windows-vmware.md](../../docs/windows-vmware.md)).

A build takes roughly 30 minutes on an M-series Mac (Windows Setup
dominates; Fusion runs the guest near-native). Everything per image lives
under the CLI's data root:
`~/Library/Application Support/agent-dev-env/build/windows-vmware/output/`
(the vmx + vmdk + nvram), plus `packer_cache/` and `drivers/staging/`.
The macOS/tart images build no files and have no such directory.

## What's in the image

| Component | Detail |
| --- | --- |
| Windows 11 Pro (ARM64) | Unactivated (watermark); generic Pro key used for Setup |
| VMware Tools | ARM64 tools from the Fusion install (attached by the builder, installed at first logon); enables `vmrun getGuestIPAddress` (no HGFS shared folders for Win11 ARM guests) |
| VMware drivers | vmxnet3 ARM64 NIC driver (staged into the unattend CD); NVMe disk uses the in-box driver |
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
| Bridge tooling | Node relays (in-image `node.exe`, written by the bundled guest agent) for the SSH-agent/Docker bridges — the host side is the CLI's own forwarder (no socat) |

## Versioning

Same convention as the other images: the image version lives in
`image_version` in the vars file; every release bumps it, adds a
`CHANGELOG.md` entry, and creates a `windows-arm64-vmware-v<version>` git
tag via `npx agent-dev-env tag <image>`.

## Running and publishing

- Run the sandbox: `npx agent-dev-env run windows-vmware` — extracts
  the archive, clones a working VM with `vmrun`, discovers the guest IP
  via VMware Tools, and bridges the host's Docker engine and SSH agent
  into the guest (see [docs/windows-vmware.md](../../docs/windows-vmware.md)).
- Publish: `npx agent-dev-env deploy sandbox-windows-11-arm64-vmware` packs
  the output directory into `${image_name}.tar.gz`, splits it into 512 MiB
  chunks and pushes them to
  `ghcr.io/<owner>/sandbox-windows-11-arm64-vmware:<version>` + `:latest` as
  an OCI artifact via `oras` (the CLI packs and pushes directly — no
  platform wrapper — because `tart push` only works for Tart VMs). Needs
  `brew install oras` and a GHCR token with `write:packages`
  (`oras login ghcr.io`).

## Gotchas

- **The Windows ISO is not in the repo.** The build fails fast without
  `WINDOWS_ISO_PATH`; the sha256 in the vars file protects against a
  corrupt download.
- **ARM64 only.** Fusion on Intel can only run x86_64 guests, so this
  image requires Apple Silicon.
- **Fusion 13.6+ and the VMware plugin v2+.** The template uses
  `github.com/vmware/vmware` (Broadcom's maintained fork); the older
  `github.com/hashicorp/vmware` plugin has different options.
- **vmxnet3 driver must be installed before any network use.**
  FirstLogonCommands order 1 scans the unattend CD (drive letters D:..H:)
  for the driver; if the CD is relocated the scan fails loudly in the
  guest and WinRM never comes up — check the build log before blaming the
  template.
- **The build uses the *host's* Fusion tools ISO.** The image's VMware
  Tools version tracks the Fusion that built it; running the VM under a
  much older Fusion can complain about unstable tools. Rebuild after a
  Fusion update, or update tools in the running guest from the new
  Fusion's ISO.
- **Tools install must not reboot the guest.** The installer passes
  `REBOOT=R` (autounattend order 2): without it the tools MSI initiates a
  reboot mid-FirstLogonCommands, orders 3-6 (network + WinRM) never run,
  and the build spins on "Waiting for WinRM" forever at the login screen.
- **No snapshot in the published image.** `snapshot_name` is deliberately
  unset: the sandbox runner makes a *full* clone as its working VM, and a
  snapshot inside the published archive would only complicate disk
  compaction and re-cloning.
- **Unactivated Windows.** The image runs indefinitely with a desktop
  watermark; personalization (wallpaper) is locked.
- **Computer name ≤ 15 chars.** `win11-sandbox` fits; longer names fail
  the specialize pass even though `xmllint`/`packer validate` pass.

## Migration notes

The v1.0.0 image reuses the exact Windows 11 25H2 ISO that
`images/windows-arm64-qemu` pins (same sha256), so the same downloaded
ISO serves both platforms.
