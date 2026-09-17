# Ubuntu Sandbox Images — VMware

Ubuntu 24.04 LTS (ARM64) sandbox VM images built with
[Packer](https://www.packer.io/) and the
[VMware plugin](https://github.com/vmware/packer-plugin-vmware)
(`vmware-iso` builder) on an Apple Silicon Mac. The output is a runnable
vmx + vmdk VM (built at the vmware-iso hardware level, upgraded post-build
to the host Fusion's current hardware version — see
[How to Build](#how-to-build)), packed into a tar.gz for publishing; the
macOS host runs it under Fusion's `vmrun` CLI. Fusion
virtualizes ARM64 guests natively; the guest uses **open-vm-tools** from
the Ubuntu archive (Fusion ships no VMware Tools for arm64 Linux — the
`isoimages/arm64/` folder contains only `windows.iso`), which provide
`vmrun getGuestIPAddress`, graceful power operations and HGFS shared
folders.

The sibling images are the macOS
([Tart](../mac/README.md)) and Windows 11 ARM64
([QEMU](../windows-arm64-qemu/README.md),
[VMware](../windows-arm64-vmware/README.md)) sandboxes. See
[docs/ubuntu-vmware.md](../../docs/ubuntu-vmware.md) for the user
guide (boot it with `npx agent-dev-env run ubuntu-vmware`).

## Prerequisites

- Apple Silicon Mac (M-series). Fusion cannot virtualize ARM64 guests on
  Intel, so this image is ARM64-only.
- [VMware Fusion](https://www.vmware.com/products/desktop-hypervisor/workstation-and-fusion)
  (free for personal use; the Packer plugin requires Fusion 13.6+).
- [Packer](https://www.packer.io/): `brew install hashicorp/tap/packer`
  (the VMware plugin is installed automatically by `packer init`).
- The **Ubuntu Server 24.04 ARM64 ISO** — bring your own, ~3 GB:

  1. Download the latest point release from
     https://cdimage.ubuntu.com/releases/24.04/release/ — the
     `ubuntu-24.04.x-live-server-arm64.iso` file.
  2. Copy its SHA256 from the release `SHA256SUMS`
     (https://cdimage.ubuntu.com/releases/24.04/release/SHA256SUMS) into
     `iso_sha256` in the vars file.
  3. Set `UBUNTU_ISO_PATH` to its absolute path when building.

That is all: the guest's vmxnet3 NIC and NVMe disk drivers are in-box in
the Ubuntu kernel (vmxnet3.ko ships in the base `linux-modules` package),
and open-vm-tools come from the Ubuntu archive — no driver or tools
staging from Fusion is needed (unlike the Windows image).

## How to Build

```bash
# From the repository root
UBUNTU_ISO_PATH=/path/to/ubuntu-24.04.4-live-server-arm64.iso \
  npx agent-dev-env build sandbox-ubuntu-24-04-arm64-vmware
```

`agent-dev-env` is the CLI shipped by this repo (see
[docs/cli.md](../../docs/cli.md)). The ubuntu-vmware build flow:

1. Verifies the host (Apple Silicon), the local ISO (SHA256 against
   `iso_sha256` from the vars file) and the Fusion install (only needed
   for the post-build hardware upgrade).
2. Starts the autoinstall seed server (`python3 -m http.server 8004`
   over `autoinstall/`) and runs `packer init` + `packer build`. The
   build is headless with **no `boot_command` typing**: the build
   watchdog (see below) waits for the grub menu/shell in the VNC OCR and
   types the autoinstall kernel line
   (`ds=nocloud-net;s=http://<vmnet8-host>:8004/` — the firmware's
   No-Media/PXE probe cycle before grub appears is variable-length, so
   the plugin's own typing was unreliable). Subiquity fetches the seed:
   LVM over the whole disk, user `admin` (password from the vars file),
   openssh-server, open-vm-tools — then reboots into the installed system
   and is provisioned over SSH.
3. Runs the VNC **build watchdog** (bundled `assets/watchdog/`) alongside
   `packer build` (pinned VNC port 5901) to auto-dismiss installer dialogs
   and rescue a boot that lands in the UEFI shell. Needs
   `pip3 install vncdotool` + Xcode command line tools; skipped with a
   warning when missing.
4. Upgrades the output VM with `vmrun upgradevm` to the hardware version
   the installed Fusion writes for a new VM (hardware version 20 → 22 on
   Fusion 26). The headless build never shows Fusion's one-time
   "Upgrade this virtual machine?" prompt, but a first GUI start of a
   version-20 VM would; the upgrade also rewrites the vmdk descriptor.
   The runner upgrades its working clone the same way for artifacts built
   by older Fusion versions (see
   [docs/ubuntu-vmware.md](../../docs/ubuntu-vmware.md)).

A build takes roughly 30 minutes on an M-series Mac (the Ubuntu installer
dominates, plus the ~8 min GNOME desktop apt install; Fusion runs the
guest near-native). Everything per image lives under the CLI's data root:
`~/Library/Application Support/agent-dev-env/build/ubuntu-vmware/output/`
(the vmx + vmdk + nvram), plus `packer_cache/`. The macOS/tart images
build no files and have no such directory.

## What's in the image

| Component | Detail |
| --- | --- |
| Ubuntu Server 24.04 LTS (ARM64) | Point release from the vars file; LVM over the whole disk |
| open-vm-tools | From the Ubuntu archive (Fusion ships no Linux tools for arm64); enables `vmrun getGuestIPAddress`, soft power ops, HGFS shared folders |
| GNOME desktop | `ubuntu-desktop-minimal` + `open-vm-tools-desktop`; boots to `graphical.target`, GDM3 auto-login as `admin`, Xorg session (software-rendered — no GPU accel in a Fusion arm64 guest) |
| apt toolchain | build-essential (gcc/g++/make), cmake, ninja-build, autoconf, git + git-lfs, curl, wget, jq, ripgrep, vim, tmux, socat, libicu-dev, python3.12 + pip/venv, ruby + rbenv; browser + X libs for Firefox |
| Go | `go<version>` tarball from go.dev/dl, hash-pinned; `/usr/local/go` |
| Rust | Via rustup (arm64 host toolchain), `rust`/`cargo` on PATH |
| Java | OpenJDK `<version>` from the archive; `JAVA_HOME` via `/etc/profile.d` (opt-in, empty = skip) |
| Gradle | Hash-pinned bin zip (`gradle-<version>-bin.zip`) in `/opt/gradle`; wrapper distribution pre-cached (opt-in, empty = skip) |
| Kotlin/Native | Not cached — JetBrains publishes no linux-aarch64 prebuilt (macOS x86_64/aarch64 and Linux x86_64 only); `kotlin_native_version` left empty |
| Android SDK | Bootstrapped into `/opt/android-sdk` (hash-pinned cmdline-tools); platform-tools/platforms/build-tools/NDK via `android_sdk_packages` (opt-in, empty = skip) |
| Node.js | Via nvm (major from the vars file, default alias); npm globals in the nvm dir, incl. `pnpm` and `yarn` |
| GitHub CLI | `gh_<version>_linux_arm64.deb`, hash-pinned |
| Visual Studio Code | `code_<version>_arm64.deb`, hash-pinned; `code` on PATH |
| Firefox | Official linux-aarch64 release tarball, hash-pinned; `/opt/firefox` (no Chrome: CfT publishes no linux-arm64 build, Ubuntu's chromium is snap-only) |
| Docker CLI | Client only (`docker` + `docker compose` + `docker buildx`, static aarch64 binaries, hash-pinned); no engine — bridged from the host |
| OpenCode (`opencode-ai`) | npm global |
| OpenCodeReview (`ocr`) | npm global (`@alibaba-group/open-code-review`) |
| OpenChamber web UI | npm global (`@openchamber/web`), systemd **user** service (`agent-dev-env-openchamber`) on `0.0.0.0:4000`, started at boot (`loginctl enable-linger`) |
| OpenChamber desktop app | linux-arm64 AppImage from the GitHub releases, hash-pinned; `/opt/openchamber/OpenChamber.AppImage` + GNOME desktop entry + `openchamber-desktop` on PATH |
| SSH | openssh-server with password auth; `admin`/sandbox1 (see the vars file); Ubuntu's default cloud-init finalization |
| Image identity | `~/.config/agent-dev-env/image.json` (image name + `image_version`, baked at build time) |
| systemd user services | Linger enabled for `admin`; the guest agent's bridge services and OpenChamber auto-start in the guest |

## Versioning

Same convention as the other images: the image version lives in
`image_version` in the vars file; every release bumps it, adds a
`CHANGELOG.md` entry, and creates a `ubuntu-arm64-vmware-v<version>` git
tag via `npx agent-dev-env tag <image>`.

## Running and publishing

- Run the sandbox: `npx agent-dev-env run ubuntu-vmware` — extracts
  the archive, clones a working VM with `vmrun`, discovers the guest IP
  via open-vm-tools, and bridges the host's Docker engine and SSH agent
  into the guest (see
  [docs/ubuntu-vmware.md](../../docs/ubuntu-vmware.md)).
- Publish: `npx agent-dev-env deploy sandbox-ubuntu-24-04-arm64-vmware`
  packs the output directory into `${image_name}.tar.gz`, splits it into
  512 MiB chunks and pushes them to
  `ghcr.io/<owner>/sandbox-ubuntu-24-04-arm64-vmware:<version>` +
  `:latest` as an OCI artifact via `oras` (the CLI packs and pushes
  directly — no platform wrapper — because `tart push` only works for
  Tart VMs). Needs `brew install oras` and a GHCR token with
  `write:packages` (`oras login ghcr.io`).

## Gotchas

- **The Ubuntu ISO is not in the repo.** The build fails fast without
  `UBUNTU_ISO_PATH`; the sha256 in the vars file protects against a
  corrupt download. The ISO is ~3 GB.
- **ARM64 only.** Fusion on Intel can only run x86_64 guests, so this
  image requires Apple Silicon.
- **Fusion 13.6+ and the VMware plugin v2+.** The template uses
  `github.com/vmware/vmware` (Broadcom's maintained fork); the older
  `github.com/hashicorp/vmware` plugin has different options.
- **No VMware Tools from Fusion — ever.** Fusion's arm64 `isoimages/`
  folder ships only `windows.iso`; open-vm-tools are the only in-guest
  tools available for arm64 Linux VMs. The image installs them from the
  Ubuntu archive, so their version tracks Ubuntu, not Fusion.
- **The autoinstall seed comes over the build flow's HTTP server, and the
  grub typing is done by the build watchdog.** The seed is fetched via
  `ds=nocloud-net` from `python3 -m http.server 8004` (`autoinstall/`),
  and the bundled `watch-build.py` types the kernel command when grub
  appears (`WATCH_BUILD_BOOT_CMD`; the firmware's No-Media/PXE probe
  cycle before grub is variable-length, so the plugin's own boot_command
  typing was unreliable and could boot the interactive Subiquity installer
  — a build then hangs waiting for SSH; check the VNC watchdog frames in
  `~/Library/Application Support/agent-dev-env/build/ubuntu-vmware/packer_cache/watchdog/`).
  The watchdog types the command blind, OCR-free: once the VNC server is
  up it presses `c` (grub shell) and types the command every 6 s over a
  bounded grid (grub's menu countdown is only ~20-30 s wide, and Fusion's
  VNC server drops the console at boot, so the slow ~2 min-per-frame OCR
  poll can miss it entirely); the OCR path resumes as the late/shell
  rescue only after the grid exhausts — the two typers never run
  concurrently (interleaved typing garbles the grub shell).
- **Keep `autoinstall/user-data` in sync with the vars file**: the seed
  bakes the sandbox user (name + crypt hash of `ssh_password`). Change
  the credentials in the vars file *and* the `identity:` block together.
- **No snapshot in the published image.** `snapshot_name` is deliberately
  unset: the sandbox runner makes a *full* clone as its working VM, and a
  snapshot inside the published archive would only complicate disk
  compaction and re-cloning.
- **The shared folder is best-effort.** HGFS via `vmhgfs-fuse`
  (`open-vm-tools`) is mounted by the runner at `/mnt/hgfs/work`; a
  missing mount is a warning, not an error (git, OpenChamber UI, and the
  agent bridges do not need it).
- **The desktop is software-rendered.** A Fusion arm64 guest has no GPU
  acceleration, so GNOME runs on llvmpipe (Xorg session,
  `WaylandEnable=false` in GDM3's custom.conf). It is meant for human
  interaction (VS Code, Firefox, OpenChamber in a browser) — not for 3D
  work; the agents do not use the GUI at all.
