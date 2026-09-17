# Changelog

All notable changes to the Ubuntu sandbox images (VMware).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The image version lives in the image's vars file (`image_version`); every
release bumps it, adds an entry below, and tags the release commit
`<platform>-v<version>` (e.g. `ubuntu-arm64-vmware-v1.0.0`). The
`[Unreleased]` section on top is never removed — changes land there until
the next release.

## [Unreleased]

## [ubuntu-arm64-vmware-v2.0.0] - 2026-09-17

### Changed

- **Breaking:** the image is published as a chunked artifact — the
  vmx + nvram + vmdk tar.gz is split into fixed-size 512 MiB chunks, one
  OCI layer per chunk (`application/vnd.agent-dev-env.image-part`),
  instead of one ~18 GiB layer. GHCR's signed download URL expires a few
  minutes after it is issued, so the single-layer pull was cut about a
  third of the way through and every retry restarted from zero; a
  chunked image is pulled chunk by chunk and a retry fetches only the
  missing chunks. Chunked images require an `agent-dev-env` CLI with
  chunked-image support and are not readable by older CLIs, which in
  turn cannot pull this image; the guest contents are unchanged
  (repackaging only).

## [ubuntu-arm64-vmware-v1.2.0] - 2026-09-06

### Added

- Dev tooling: `ninja-build`, `git-lfs` (filters wired for root and the
  sandbox user), `libicu-dev`, plus `pnpm` and `yarn` as nvm-global
  package managers.
- JVM/Android parity with the macOS image (same empty-by-default vars):
  `rbenv`, OpenJDK 17 (`JAVA_HOME` via `/etc/profile.d`), Gradle 8.7 with
  a wrapper pre-cache, and the Android SDK into `/opt/android-sdk` (NDK +
  build-tools, licenses accepted). Kotlin/Native is not cached —
  JetBrains publishes no linux-aarch64 tarballs.
- The OpenChamber desktop app (hash-pinned linux-arm64 AppImage) with a
  GNOME desktop entry.
- The image records its own identity inside the guest
  (`~/.config/agent-dev-env/image.json`).
- Host user settings sync into the Ubuntu guest (opencode, Copilot,
  VS Code, mcp-compress-router, SSH dotfiles, `.gitconfig`) once per VM,
  marker-gated, plus `agent-dev-env sync` to re-apply on demand.

### Changed

- Node.js is bumped from 22 to 26 (`node_version = "26"`).

### Fixed

- The Java provisioner no longer clobbers `PATH` in login shells — `go`
  and the Android `sdkmanager`/`platform-tools` stay on PATH (the
  profile.d script kept a transient, unquoted `$PATH`).
- The shared host directory no longer fails when registered before
  VMware Tools are up — the runner waits for `checkToolsState` and
  retries `addSharedFolder`.
- The host settings copy survives the root-owned `~/.local` intermediate
  dir (chowned back before unpacking) and strips macOS `._*` /
  `.DS_Store` junk.
- mcp-compress-router settings land in the XDG data dir
  (`~/.local/share/mcp-compress-router/`), not `~/.config` — the old path
  was never picked up.
- The build watchdog no longer misses the grub menu: it fast-polls while
  the autoinstall command is untyped and has an OCR-free blind typing
  path, serialized with the OCR rescue.
- The `python_version` var is now actually enforced by the template
  (`python3.<minor>` installed, build fails on mismatch).
- The Kotlin/Native pre-cache no longer fails the build — removed
  (`kotlin_native_version` is empty; no linux-aarch64 artifacts upstream).

## [ubuntu-arm64-vmware-v1.1.0] - 2026-08-25

### Added

- **GNOME desktop in the image** — `ubuntu-desktop-minimal` (GNOME Shell +
  GDM3 + core apps) and `open-vm-tools-desktop` (SVGA Xorg driver,
  clipboard, drag-and-drop) are installed by the Packer provisioners, the
  VM boots to `graphical.target`, and GDM3 auto-logs in `admin` — the
  Fusion window opens straight on the desktop (VS Code, Firefox,
  OpenChamber-in-browser). The session runs on Xorg (`WaylandEnable=false`):
  Fusion guests get no GPU acceleration, and the Xorg session works best
  with the open-vm-tools input drivers. Display is
  software-rendered (llvmpipe) — for human interaction, not 3D.

### Changed

- The grub kernel command is typed by the **build watchdog**
  (`scripts/watch-build.py` gained a `WATCH_BUILD_BOOT_CMD` mode: grub
  menu/shell detected in the OCR → type the autoinstall command, once per
  build, marker-guarded) instead of the Packer `boot_command` — the
  firmware's No-Media/PXE probe cycle before grub appears is
  variable-length (~20-40 s on Fusion), so packer-side typing fired
  before grub was up and the menu's default entry booted the interactive
  Subiquity installer. A `boot-typed.png` frame is captured after typing
  for debugging.
- The autoinstall seed is served by a small HTTP server the build wrapper
  starts on a fixed port (`python3 -m http.server 8004` over
  `autoinstall/`; the seed is fetched via
  `ds=nocloud-net;s=http://<vmnet8-host>:8004/`) instead of
  `http_directory` — the plugin's HTTP server uses a random port and does
  not accept an `http_port` override, and the URL must be known when the
  grub command is typed. The vmnet8 host address is read from Fusion's
  DHCP config.
- `identity.password` in the seed uses a clean crypt salt (the previous
  salt contained '!', not a valid crypt salt character).

### Fixed

- The provisioner heredocs used `$$` for shell variables (HCL only
  escapes `$${`; bash expanded `$$` to its PID — observed as `$NVM_DIR`
  set to "4330HOME/.nvm"). They now use plain `$`.
- `set_vm_display_name` in `scripts/lib/vmware.sh` matched only the
  camelCase `displayName` key, but `vmrun clone` writes lowercase
  `displayname` — the rename then *appended* a second, case-variant key,
  and Fusion refuses a vmx with duplicate keys ("Cannot read the virtual
  machine configuration file"), so the runner's first `vmrun start` failed
  on freshly cloned VMs. It now matches case-insensitively and writes the
  canonical lowercase key, dropping duplicates.
- The guest-side bridge setup used plain `sudo`, but the runner's SSH
  sessions are deliberately pty-less (raw-stdin uploads depend on it), so
  sudo failed with "a terminal is required". `sudo` now runs with `-S`
  (password from stdin, answered by the runner's expect session, whose
  prompt pattern matches "[sudo] password for ..." too), and
  `guest-setup.sh` writes the profile.d file to a temp path and installs
  it with `sudo -S install` — `sudo -S tee <<EOF` would eat the first
  heredoc line as the password.
- The base apt list uses the 24.04 `t64` names (`libasound2t64`,
  `libfuse2t64`, `libgtk-3-0t64`) — the plain names have no install
  candidates.
- Docker plugin installs use the `docker-` prefixed names
  (`docker-compose`, `docker-buildx` — docker only discovers prefixed
  plugin files) and mirror them into the user plugin dirs; the buildx
  URL includes the release's `v` prefix (the tag and asset are
  `v0.36.1`/`buildx-v0.36.1.linux-arm64`).
- opencode is installed via the official installer script
  (`curl https://opencode.ai/install | bash`) — the npm package
  postinstall mis-selects the arm64-musl binary on glibc systems
  (EBADPLATFORM) — and the XDG dirs (`~/.local/share` and friends) are
  pre-created with correct ownership (opencode's first run hit EACCES).
- Google Chrome is not part of the image: CfT publishes no linux-arm64
  build (only x86_64 linux64) and Ubuntu's chromium is snap-only; Firefox
  (official linux-aarch64 releases) is the browser.
- The final verification checks nvm/node/npm, opencode/ocr/openchamber
  and rust through the sandbox user (they live in the user's home, and
  the verification shell runs as root).
- Removed the invalid `user-data:`/`late-commands` blocks from the seed:
  subiquity's schema rejected them ("Cloud config schema errors ...
  Additional properties are not allowed"), aborting autoinstall —
  despite the seed being served fine. The seed exactly matches the first
  proven build.

## [ubuntu-arm64-vmware-v1.0.0] - 2026-08-25

### Added

- **New platform: Ubuntu 24.04 LTS (ARM64) sandbox image for VMware
  Fusion** — `images/ubuntu-arm64-vmware/`:
    - `sandbox.pkr.hcl` — Packer `vmware-iso` template (same Proven
    ARM64 wiring as the Windows VMware image: `guest_os_type
    "arm-ubuntu-64"`, hardware version 20, NVMe disk, vmxnet3 NIC under
    NAT, EFI firmware, headless + VNC on the pinned port 5901). Ubuntu
    Server 24.04 ARM64 is autoinstalled via Subiquity: the installer
    kernel gets `autoinstall ds=nocloud-net;s=http://.../` in the
    `boot_command` and fetches `autoinstall/user-data` +
    `meta-data` from Packer's HTTP server (LVM layout, user
    `admin`/sandbox1, openssh-server, open-vm-tools). Provisioned over
    SSH; the image ships the same toolchain as the other sandboxes
    (apt base toolchain, hash-pinned Go/Rust/nvm Node/GitHub CLI/VS
    Code/Chrome CfT/Firefox/Docker CLI + compose + buildx, npm globals
    opencode/`ocr`/OpenChamber). OpenChamber runs as a systemd **user**
    service (`agent-dev-env-openchamber`, linger enabled) on
    `0.0.0.0:4000`.
    - `vars/sandbox-ubuntu-24-04-arm64-vmware.pkrvars.hcl` — Ubuntu point
    release, ISO SHA256, all pinned toolchain versions + hashes, VM
    resources, credentials, OpenChamber, `image_version`.
    - `build.sh` — platform wrapper: ISO SHA256 verification, `packer
    init` + `packer build` into `build/ubuntu-arm64-vmware/`, VNC build
    watchdog, post-build `vmrun upgradevm` hardware upgrade (shared
    helper, see below). No driver/tools staging from Fusion is needed —
    the vmxnet3 + NVMe drivers are in-box in the Ubuntu kernel
    (verified: `vmxnet3.ko` ships in the base `linux-modules` package)
    and open-vm-tools come from the Ubuntu archive (Fusion ships no
    Linux tools ISO for arm64 guests).
    - `deploy.sh` — platform wrapper: packs the output directory into a
    tar.gz and pushes `ghcr.io/<owner>/<image>:<version>,latest` as an
    OCI artifact via `oras`.
    - `README.md` — build/publish flow, "What's in the image", gotchas.
- **`scripts/lib/vmware.sh`** — the generic vmrun helpers (vmrun
  resolution, hardware-version upgrade, vmx displayName) factored out of
  `scripts/lib/windows-vmware/lib.sh` (which is now a thin shim sourcing
  it), shared by both VMware platforms.
- **`scripts/run-ubuntu-vmware-sandbox.sh`** — user-facing runner: picks
  the archive (env override → local build output → GHCR pull via oras),
  extracts the pristine VM + `vmrun clone`s a working VM (one-time
  hardware-version upgrade), boots it (headless or windowed), discovers
  the guest IP via open-vm-tools, and bridges the host's SSH agent and
  Docker engine into the guest — host-side `socat` on TCP 4400/4401
  bound to the vmnet8 address + guest-side systemd user services
  (`scripts/lib/ubuntu-vmware/guest-setup.sh` renders socat relays for
  `/tmp/ssh-agent.sock` and `/tmp/docker.sock` plus the
  `/etc/profile.d` exports, auto-start via linger). Optionally shares a
  host directory (`--work-dir`, HGFS → `/mnt/hgfs/work`), installs the
  sandbox agent rules (`scripts/agent-rules-linux.md`) into the guest's
  opencode + Copilot configs, and verifies OpenChamber.
- **`scripts/stop-ubuntu-vmware-sandbox.sh` / `delete-ubuntu-vmware-sandbox.sh`** —
  stop the working VM (`vmrun -T fusion stop`, graceful + hard fallback)
  and kill the host bridge listeners; delete the state dir (extracted
  base + working clone + pulled image cache) after a confirmation.
- **`scripts/agent-rules-linux.md`** — sandbox environment rules for the
  Ubuntu guest (shared-directory path mapping, host Docker engine via
  `/tmp/docker.sock`, published ports at the NAT gateway, SSH agent
  socket).
- **Docs**: `docs/linux.md` replaces its "not supported yet" placeholder
  with the full Ubuntu VMware sandbox guide; `README.md`,
  `DEVELOPMENT.md` and `AGENTS.md` list the new platform and the
  shared `scripts/lib/vmware.sh` helper.

[unreleased]: https://github.com/ameshkov/agent-dev-env/compare/ubuntu-arm64-vmware-v2.0.0...HEAD
[ubuntu-arm64-vmware-v2.0.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/ubuntu-arm64-vmware-v2.0.0
[ubuntu-arm64-vmware-v1.2.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/ubuntu-arm64-vmware-v1.2.0
[ubuntu-arm64-vmware-v1.1.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/ubuntu-arm64-vmware-v1.1.0
[ubuntu-arm64-vmware-v1.0.0]: https://github.com/ameshkov/agent-dev-env/releases/tag/ubuntu-arm64-vmware-v1.0.0
