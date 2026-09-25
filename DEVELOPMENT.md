# Development Guide

This document explains how to build and debug the `agent-dev-env` CLI
and the image recipes in this repo, and what a developer must have
installed. It is the *how* — the *what* (project map, build/use
commands, releases, tags, changelogs, code guidelines) lives in
[AGENTS.md](AGENTS.md), and the user-facing reference is
[docs/cli.md](docs/cli.md) + the per-OS guides under [docs/](docs/).
Keep the docs in sync whenever you change how an image behaves.

## What is a "recipe"?

Each supported platform has a directory under `images/` containing:

1. **A Packer template** (`sandbox.pkr.hcl`) — describes how to build the
   image: the base image it derives from, the resources of the VM, and
   the provisioning steps that install software.
2. **Variables files** (`vars/*.pkrvars.hcl`) — one file per image: the
   OS version, disk size, and the image's semantic version
   (`image_version`, the single source of truth).
3. **A README.md and a CHANGELOG.md** — per-platform image docs and
   history (see AGENTS.md → Releases, Tags, and Changelogs for the
   version/tag model).

The build/publish flows (`build`, `deploy`, `tag`, `watch-build`) are
implemented in the CLI (`packages/agent-dev-env-cli/src/lifecycle/`) and
ship inside the npm package — no shell scripts, and no repo checkout for
`build`/`deploy` (`tag` needs a checkout, see AGENTS.md). The running
side of a recipe (how to run the VM, share directories, the SSH agent
bridge, etc.) lives in the per-OS user guides under [docs/](docs/).

Contributors working in the repo build the CLI first (`pnpm build`), then
run it through the root `agent-dev-env` script
(`pnpm agent-dev-env <command>`). End users of the published npm package
use `npx agent-dev-env` — see docs/cli.md for both.

## Prerequisites

Everything a developer needs, at a glance:

| Need | For | Install |
| --- | --- | --- |
| macOS host, Apple Silicon | everything — Tart/QEMU/Fusion cannot virtualize ARM64 guests on Intel | — |
| Node.js 26+ + pnpm 10+ | building/dev-running the CLI | `corepack enable` or `npm i -g pnpm` |
| Xcode command-line tools | the VNC build watchdog (Swift OCR) and `hdiutil` driver staging | `xcode-select --install` |
| Tart + Packer | macOS image builds | `brew install cirruslabs/cli/tart` and `brew install hashicorp/tap/packer` |
| QEMU + swtpm + Packer | Windows QEMU image builds | `brew install qemu swtpm` and `brew install hashicorp/tap/packer` |
| VMware Fusion 13.6+ + Packer | Windows/Ubuntu VMware image builds | Fusion (free for personal use) + `brew install hashicorp/tap/packer` |
| oras | GHCR pull/push of the file-based images | `brew install oras` |
| vncdotool + Swift compiler | VNC build watchdog | `pip3 install vncdotool` (+ Xcode CLT above) |
| ~230 GB free disk | macOS build (base image ~70 GB + 160 GB disk); ~150 GB for others | — |

### Bring-your-own files

- **Windows 11 ARM64 ISO** — `WINDOWS_ISO_PATH`, Microsoft does not
  permit redistribution; download steps in
  [images/windows-arm64-qemu/README.md](images/windows-arm64-qemu/README.md)
  and [images/windows-arm64-vmware/README.md](images/windows-arm64-vmware/README.md).
- **Ubuntu Server 24.04 ARM64 ISO** — `UBUNTU_ISO_PATH`; download steps
  in [images/ubuntu-arm64-vmware/README.md](images/ubuntu-arm64-vmware/README.md).
- **virtio-win.iso** — only for the Windows QEMU build; downloaded into
  the cache automatically unless `VIRTIO_WIN_ISO_PATH` is set.

### Publish credentials

- A GitHub token with `write:packages`
  (`https://github.com/settings/tokens/new?scopes=write:packages`)
  for `deploy` — `tart login ghcr.io` for macOS images, `oras login
  ghcr.io` for the file-based ones.

`agent-dev-env doctor` performs the whole per-platform prerequisite +
disk check (see docs/cli.md).

## Building and debugging the CLI

### Build

`pnpm install` once, then `pnpm build` (the script is
`packages/agent-dev-env-cli/scripts/copy-assets.mjs`):

1. compiles the CLI TypeScript (`tsc -p tsconfig.app.json`) into
   `packages/agent-dev-env-cli/dist/`;
2. bundles the workspace guest-side packages into single-file JS
   artifacts with esbuild (`dist/assets/bridge/bridge.js`,
   `dist/assets/guest/guest-agent-*.js`) — node built-ins only, no
   runtime deps; this is how guests get the bridge/agent code (SFTP'd in,
   run with `node`, no npm install inside guests);
3. copies the runtime assets (`assets/**`) and the `images/**` snapshot
   into `dist/assets/` (removed first, so stale files never survive);
4. copies the repo root `README.md` into the CLI package root — npm
   shows a package readme only from a README at the package root, so the
   published `agent-dev-env` package ships this repo README (the file is
   generated and gitignored).

`dist/` is the npm package payload — verify with `npm pack --dry-run`
from `packages/agent-dev-env-cli` (the README and LICENSE it adds are
picked up automatically by npm). The bundled `images/` snapshot is what
feeds the CLI's image catalog (`list`/`build`/`deploy` work without a
repo checkout).

### Publish to npm

`pnpm publish-npm` (root script) publishes `agent-dev-env` to npm. The
CLI package's `prepublishOnly` hook builds first (runs
`scripts/copy-assets.mjs`: tsc + esbuild bundles + assets + the
generated package README — so a publish from a fresh checkout still
ships everything, README included), and it then runs `pnpm --filter
./packages/agent-dev-env-cli publish --no-git-checks --provenance
--access public`. The CI workflow runs it on `agent-dev-env-v*` tags —
npm authenticates via OIDC Trusted Publishers (no token) and provenance
comes from the `id-token` permission. `pnpm publish-npm` replaces any
raw `npm publish` from `packages/agent-dev-env-cli`.

`pnpm publish-npm:canary` is the same publish with `--tag canary`: the CI
workflow runs it on every push to `master` after setting a temporary
`<version>-canary.<run>.<sha>` version in the CLI package (never
committed). Install the pre-release build with
`npm install -g agent-dev-env@canary`.

### Run

After `pnpm build`, the root `agent-dev-env` script executes
`packages/agent-dev-env-cli/dist/cli.js`:

```bash
pnpm agent-dev-env --help
```

Rebuild after any TypeScript change (`pnpm build`); `pnpm typecheck`
catches type errors without emitting.

### Test

- `pnpm test` — Vitest run; `pnpm test:watch` for the dev loop.
- Tests are co-located (`src/**/*.test.ts`); shared test helpers live in
  `test/` without the `.test.ts` suffix.
- Prefer real fixtures over mocks: tmpdirs for file I/O, real vars files
  for catalog tests, real process spawning where possible.
- There is no CI E2E: the only end-to-end checks are full image builds
  (~1 hr) and per-phase smoke runs of the CLI against real platforms. The
  GitHub Actions workflow (`.github/workflows/ci.yml`) runs the full
  local gate (`pnpm check`) on every push and PR and, on `agent-dev-env-v*`
  tags, publishes the `agent-dev-env` npm package and creates a GitHub
  release — it never builds or tests real VMs.

### Debug

- CLI logs: `~/Library/Logs/agent-dev-env/` (`AGENT_DEV_ENV_LOG_DIR`
  overrides); VM/workdir state under `<data>/` (see docs/cli.md → Paths).
- `PACKER_LOG=1` before a `build` — verbose Packer output.
- `agent-dev-env watch-build <vnc-port> [outdir]` — the same VNC build
  watchdog in the foreground, with hard errors when prerequisites are
  missing (a `build` only warns and skips).
- `packer validate -var-file=vars/<image>.pkrvars.hcl sandbox.pkr.hcl` —
  from `images/<platform>/`: fast HCL check without a build.
- Build context under `<data>/build-context/<platform>/` — the writable
  copy of `images/<platform>` a flow materializes (templates, staged
  drivers): inspect it to see exactly what Packer gets.
- Watchdog frames/logs: `<data>/build/<platform>/packer_cache/watchdog/`.
- The per-platform build flows are `lifecycle/build-<platform>.ts`;
  their pure arg builders are unit-tested, only the end-to-end pipeline
  needs a real host.

## Build outputs

`agent-dev-env build` materializes the packer context and writes outputs
under the CLI's data root — `<data>/build/<platform>/` (on macOS
`~/Library/Application Support/agent-dev-env/build/`; override with
`AGENT_DEV_ENV_DATA_HOME`). Per-image artifacts (`output/`, `packer_cache/`,
`drivers/staging/`, watchdog frames) live there:

- macOS (Tart) images build no files — the `tart` builder leaves the VM in
  the Tart store (`~/.tart/vms/`), so macOS has no build directory.
- windows-qemu: `output/sandbox-windows-11-arm64-qemu.qcow2` (zstd).
- windows-vmware: `output/sandbox-windows-11-arm64-vmware.{vmx,vmdk,etc}`.
- ubuntu-vmware: `output/sandbox-ubuntu-24-04-arm64-vmware.{vmx,vmdk,etc}`.

## Image provenance

Every sandbox answers "which image is this from" on the host and inside the
guest (no forensics, no boot needed):

- **Guest identity** — the Packer templates bake
  `~/.config/agent-dev-env/image.json` into each image (image name,
  `image_version`, platform, base OS versions). Clones inherit it.
- **Host records** — the runners keep two JSON files next to the per-image
  state root (`lib/provenance.ts`):
    - `<data>/<platform>/<image>/image.json` — the pristine image's pull
      record: the GHCR ref + a best-effort registry digest
      (`oras manifest fetch --descriptor`) + pull time;
    - `<data>/<platform>/<image>/clone.json` — the working VM's clone
      record: the source (tart image / qcow2 overlay / vmx clone), the
      `path|size|mtime` artifact identity (non-Tart backends), and the clone
      time. Backfilled records are written for working VMs cloned before
      provenance tracking.

Records are best-effort and never fatal (`resolveRegistryDigest` returns
undefined on any failure; the readers tolerate missing/corrupt files).
`status` and the run summaries print them; they are cleared when the
working VM is deleted (`--reset`, `delete`), and the image record when the
pristine image is deleted (`--pristine`).

## macOS images

### How they are built

`images/mac/sandbox.pkr.hcl` uses the
[Tart Packer plugin](https://github.com/cirruslabs/packer-plugin-tart) (source
`tart-cli`). The builder:

1. **Clones a Cirrus Labs base image** from GHCR
   (`ghcr.io/cirruslabs/macos-<version>-xcode:<xcode-tag>`) — a pre-built
   macOS with Xcode, Homebrew, SSH (`admin`/`admin`) and the Tart Guest Agent.
   Available tags:
   https://github.com/orgs/cirruslabs/packages?tab=packages&q=macos-
2. **Boots it headless** and provisions it over SSH (`admin`/`admin`):
   - system setup: Xcode license, Remote Login, Screen Sharing, **auto-login**
     as `admin` (boots to the desktop; also creates the unlocked
     `login.keychain` required for headless runs on macOS 15+);
   - Homebrew toolchain: `nvm` (Node.js version manager; installs the
     `node_version` from the vars file as the default), `python@<python_version>`
     (also from the vars file), `ruby` + CLI
     utilities (`brew_formulas` variable — includes `socat` for the CLI
     toolchain, see [docs/macos.md](docs/macos.md), and the Docker CLI
     with `docker compose`/`docker buildx` plugins — client only, the guest
     can't run a local container engine, see
     [docs/macos.md](docs/macos.md)); unversioned
     `python`/`pip` aliases;
   - Visual Studio Code (latest stable, from
     `update.code.visualstudio.com`) with the `code` CLI on PATH;
   - Sublime Text (latest stable, Homebrew cask `sublime-text`) with the
     `subl` CLI on PATH;
   - Google Chrome and Mozilla Firefox (latest stable universal macOS
     builds, via Homebrew casks; quarantine is stripped with `xattr` so they
     launch without Gatekeeper prompts);
   - OpenCode V2 (`brew install anomalyco/tap/opencode-v2` — the tap's
     plain `opencode` formula still installs V1);
   - OpenCodeReview (`npm install -g @alibaba-group/open-code-review`) — the
     `ocr` AI code review CLI; its global config
     (`~/.opencodereview/config.json`) is synced from the host with the user
     settings (see "User settings on the guest" in docs/macos.md);
   - OpenChamber desktop app (`brew install --cask openchamber`) — the
     native macOS app for the guest desktop; quarantine stripped so it
     launches without Gatekeeper prompts;
   - OpenChamber (`npm install -g @openchamber/web`) — the 2.x web UI for
     OpenCode V2;
     installed as a login service (LaunchAgent) listening on `0.0.0.0:4000`,
     reachable from the host at `http://<vm-ip>:4000` (see
     [docs/macos.md](docs/macos.md)). The build pins the absolute `opencode`
     path into the service via `OPENCODE_BINARY` (the `startup enable`
     environment snapshot);
   - final version check.
3. Leaves a runnable VM named `sandbox-macos-<macos-version>`.

### Building an image

```bash
# From the repository root
pnpm agent-dev-env build sandbox-macos-tahoe
```

Without an argument, `agent-dev-env build` builds every image in
`images/*/vars/`. Pass image names to build just those.

Notes:

- Prerequisites: see the table above (Apple Silicon + Tart + Packer).
- The first build pulls the ~70 GB base image — be patient.
- The builder **fails if a VM with the same name already exists** (Packer
  leaves the VM in `~/.tart/vms/`). Delete it first:
  `tart delete sandbox-macos-tahoe`.
- Set `PACKER_LOG=1` for verbose Packer output.

### Adding a new macOS version

An image is a single macOS version; the image name is fixed per version
(`sandbox-macos-<macos-version>`) and does not include the Xcode version.
To add a new one:

1. Pick a base image tag from the
   [Cirrus Labs package list](https://github.com/orgs/cirruslabs/packages?tab=packages&q=macos-)
   (e.g. `macos-sequoia-xcode:15.4`).
2. Copy the latest vars file:

   ```bash
   cp images/mac/vars/sandbox-macos-tahoe.pkrvars.hcl \
      images/mac/vars/sandbox-macos-sequoia.pkrvars.hcl
   ```

3. Edit the new vars file: set `macos_version` / `xcode_version` /
   `node_version` / `python_version` / `disk_size`, set `image_version` to
   `1.0.0`, and add image-specific brew formulas to `extra_brew_formulas` if
   needed.
4. Build locally (`pnpm agent-dev-env build sandbox-macos-sequoia`) and make
   sure it works.
5. Add a `CHANGELOG.md` entry for the initial version.
6. Commit the new image.

### Template variables

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `macos_version` | string | — | Cirrus base image macOS version, e.g. `tahoe`; part of the image name (`sandbox-macos-<macos_version>`) |
| `xcode_version` | string | — | Cirrus base image Xcode tag, e.g. `26.5` (selects the base image only; not part of the image name) |
| `node_version` | string | — | Node.js version installed via nvm and set as the default, e.g. `26` |
| `python_version` | string | — | Homebrew Python version, e.g. `3.14` (also used for the unversioned `python`/`pip` aliases) |
| `image_version` | string | — | Semantic version this image is published under; bump it + add a `CHANGELOG.md` entry per release |
| `disk_size` | number | `160` | VM disk size in GB; must be ≥ the Cirrus base image disk (140 GB), tart can only grow a disk |
| `cpu_count` | number | `4` | CPU count of the VM |
| `memory_gb` | number | `8` | RAM of the VM in GB |
| `ssh_username` | string | `admin` | SSH user used for provisioning (fixed in the Cirrus Labs base images) |
| `ssh_password` | string | `admin` | SSH password used for provisioning (fixed in the Cirrus Labs base images) |
| `openchamber_ui_password` | string | `sandbox` | Password protecting the OpenChamber web UI; required because the server binds to `0.0.0.0` (host access: `http://<vm-ip>:4000`, see [docs/macos.md](docs/macos.md)) |
| `brew_formulas` | list(string) | core toolchain | Installed by `brew install` in every image |
| `extra_brew_formulas` | list(string) | `[]` | Image-specific additions to `brew_formulas` |

### Publishing

Images are published to GHCR with a semantic version tag (from
`image_version` in the image's vars file) plus `:latest`:

```bash
# One-time: authenticate with a token that has `packages:write`
tart login ghcr.io

# Push the locally built VM with its version tag and :latest
pnpm agent-dev-env deploy sandbox-macos-tahoe
```

`agent-dev-env deploy` without an argument pushes every image; the GHCR
owner resolution is described in AGENTS.md (env → flag → git remote →
default).

The first push of an image creates a new GHCR package, and GitHub does
**not** link it to this repository automatically. After the first
`deploy` run, open the package settings page
(`https://github.com/users/<owner>/packages/container/<image>/settings`)
and link it to `agent-dev-env`; until then it does not show up on the
repository's Packages tab. New packages are also **private** by default —
change the visibility to public on the same page if the images should be
pullable by anyone.

### Releasing a new image version

The version/tag/changelog conventions are in AGENTS.md ("Releases, Tags,
and Changelogs"). For an image release: bump `image_version` in the vars
file, add the `[<platform>-v<version>]` entry to
`images/mac/CHANGELOG.md`, commit, then:

```bash
pnpm agent-dev-env tag sandbox-macos-tahoe   # creates mac-v1.2.0
pnpm agent-dev-env build sandbox-macos-tahoe
pnpm agent-dev-env deploy sandbox-macos-tahoe
```

`tag` verifies the clean working tree and the matching `[<tag>]`
changelog entry before creating the annotated tag and pushing it to
origin. It needs a checkout of the repo (`--repo <path>` overrides).

## Windows images

### How they are built

`images/windows-arm64-qemu/sandbox.pkr.hcl` uses the
[QEMU Packer plugin](https://developer.hashicorp.com/packer/integrations/hashicorp/qemu)
(source `qemu`). Windows 11 ARM64 is installed from the official Microsoft
ISO (bring-your-own — Microsoft does not permit redistribution, so the ISO
is not in the repo) with `autounattend.xml` answering Setup. The builder:

1. **Boots an ARM64 VM under QEMU on Apple Silicon's HVF accelerator**
   (near-native speed; HVF can only virtualize ARM64 guests, so the image
   is ARM64-only). `machine_type = "virt,gic-version=max"`, `cpu_model =
   "host"`, UEFI via the edk2 AAVMF firmware that Homebrew's qemu ships,
   and a TPM 2.0 provided by `swtpm` (a Windows 11 system requirement).
   The install ISO, the unattend CD, and virtio-win.iso are all attached
   as usb-storage devices (the ARM `virt` machine has no IDE/SATA
   controller and WinPE has in-box xHCI drivers); the TPM, display, USB
   input and CD wiring is appended by `qemu-with-tpm.sh`, which wraps
   `qemu-system-aarch64` because the plugin's `qemuargs` option replaces
   its auto-generated args instead of appending.
2. **Installs Windows unattended.** `autounattend.xml` (all components
   `processorArchitecture="arm64"`): pure-UEFI disk layout (ESP + MSR +
   NTFS), "Windows 11 Pro" image, LabConfig bypasses for the Win11
   hardware checks (required because `-cpu host` advertises Apple Silicon
   to the guest), OOBE bypass for the Microsoft-account requirement, and
   FirstLogonCommands that register the staged virtio drivers (NetKVM
   does not survive the WinPE → installed-system handoff), force the
   network profile to Private, and bring up WinRM on 5985.
3. **Provisions over WinRM** (`Administrator`/password from the vars
   file, elevated token): virtio guest tools (full driver suite + qemu
   guest agent), Chocolatey + toolchain (Node.js, Python, Git, GitHub
   CLI, ripgrep, jq, curl, Firefox, Docker CLI — versions pinned in the
   vars file; Chrome comes from Google's live ARM64 enterprise channel),
   Visual Studio Code (native arm64, direct download),
   OpenCode V2 (`@opencode/cli`), OpenCodeReview (`ocr`), the OpenChamber web
   UI as a native service on port 4000 (with the `OPENCODE_BINARY` pin,
    like the macOS template), OpenSSH Server + RDP, and the bridge
    tooling (Node.js in-image relays; the host side is the CLI's own
    bridge forwarder — no socat — see docs/windows-qemu.md). Finishes
    with hardening (Defender realtime scan, telemetry/indexer services,
    hibernation), a version banner, and cleanup.
4. Leaves a qcow2 disk image at
   `~/Library/Application Support/agent-dev-env/build/windows-qemu/output/sandbox-windows-11-arm64-qemu.qcow2`,
   compressed with zstd.

### Building an image

```bash
# From the repository root; the ISO is required
WINDOWS_ISO_PATH=/path/to/Win11_24H2_English_Arm64.iso \
  pnpm agent-dev-env build sandbox-windows-11-arm64-qemu
```

The windows-qemu flow verifies the ISO against `iso_sha256` from the vars
file, downloads virtio-win.iso into the build cache when
`VIRTIO_WIN_ISO_PATH` is unset, stages the ARM64 driver subset into
`drivers/staging/` (packed into the unattend CD — WinPE drive letters on
ARM64 are non-deterministic, so a separate drivers CD is unreliable),
starts `swtpm`, wraps packer's qemu binary with `qemu-with-tpm.sh`, runs
the VNC build watchdog, and zstd-compresses the output. A build takes
roughly 30 minutes on an M-series Mac.

### VMware images (`images/windows-arm64-vmware`)

The VMware sibling reuses the same Windows 11 Pro ARM64 guest and
provisioners (the Choco/toolchain, OpenChamber, OpenSSH, and hardening
provisioners are identical to the QEMU template) but is built with the
[vmware-iso builder](https://github.com/vmware/packer-plugin-vmware)
(`github.com/vmware/vmware` plugin v2+, Fusion 13.6+ on Apple Silicon):

1. **Fusion hosts the installer** — `guest_os_type "arm-windows11-64"`,
   hardware version 20, NVMe disk (in-box driver — no WinPE storage driver
   needed), vmxnet3 NIC on NAT, EFI firmware. The plugin drives Fusion via
   `vmrun`; the build is headless (VNC on the pinned port 5901) and, like
   the QEMU image, runs the shared build watchdog.
2. **The unattend CD carries the only staged driver** — the ARM64 vmxnet3
   NIC driver (inf/sys/cat), extracted by the build flow from the Fusion
   app bundle
   (`Contents/Library/isoimages/arm64/drivers-arm64.zip`) into
   `drivers/staging/`. Windows 11 ARM64 has no in-box VMware NIC driver,
   so `FirstLogonCommands` order 1 installs it before any network use
   (WinRM from the host would never come up otherwise); WinPE is offline,
   so no WinPE driver is staged.
3. **VMware Tools are attached, not downloaded** — the builder's
   `tools_mode "attach"` plugs in Fusion's own ARM64 tools ISO
   (`Contents/Library/isoimages/arm64/windows.iso`), so the tools version
   always matches the host Fusion; `autounattend.xml` installs them at
   first logon, *before* WinRM comes up — the tools installer rebinds the
   NIC and kills a live WinRM session, so a provisioner-based install
   times out. The tools are what make `vmrun getGuestIPAddress` work at
   runtime (HGFS shared folders are not supported for Windows 11 ARM
   guests on Apple silicon — see docs/windows-vmware.md).
4. **Leaves a runnable vmx + vmdk** at
   `~/Library/Application Support/agent-dev-env/build/windows-vmware/output/sandbox-windows-11-arm64-vmware.vmx`
   (disk type 0, monolithic sparse; no build-time snapshot — the runner
   makes a full `vmrun clone` as the working VM). `build` then upgrades the
   VM to the hardware version the installed Fusion writes for a new VM
   (`vmrun upgradevm`): the builder's level 20 VM would show a one-time
   "Upgrade this virtual machine?" prompt on the first GUI start under a
   newer Fusion (22 on Fusion 26). The runner upgrades its working clone
   the same way, so artifacts built by older Fusion versions start clean
   too.

Build:

```bash
WINDOWS_ISO_PATH=/path/to/Win11_25H2_English_Arm64_v2.iso \
  pnpm agent-dev-env build sandbox-windows-11-arm64-vmware
```

The runtime side is `agent-dev-env run windows-vmware` — no port
forwarding: the guest sits on Fusion's NAT network (vmnet8) and the host
is its router, so the runner just discovers the guest IP via VMware Tools
and exposes the bridges on the host's NAT address (the guest's default
gateway — Fusion's NAT runs in userspace, no host interface; see
[docs/windows-vmware.md](docs/windows-vmware.md)).

### Build watchdog

The headless build is not self-driving: its `boot_command` types Enter 15
times at boot to answer the firmware's prompts, and those stray keys can
hit "Cancel" on Windows Setup's "Installing Windows 11" screen — Setup
then asks "Are you sure you want to quit?" and the build stalls forever.
Boot races can also land in the UEFI shell. The template pins the plugin's
VNC server to port 5901 and `build` starts the bundled watchdog
(`assets/watchdog/watch-build.py`) around `packer build`: it polls the VNC
framebuffer, OCRs each frame with Apple Vision
(`assets/watchdog/watch-build-ocr.swift`, compiled on first use), and

- clicks "No" on the quit-confirmation dialog (at the OCR'd button
  position, with a fallback for the 800x600 framebuffer),
- presses a key when "Press any key to boot from CD or DVD" is on screen,
- boots the ISO from the UEFI shell (`fs0:` + `EFI\BOOT\BOOTAA64.EFI`).

The Python supervisor runs every capture in a subprocess with a hard
timeout, so a hung VNC/OCR cycle cannot stall the watch. Prerequisites:
`pip3 install vncdotool` + the Xcode command line tools; `build` skips the
watchdog with a warning when they are missing (`--no-watchdog` skips it
explicitly). Frames and logs land in
`~/Library/Application Support/agent-dev-env/build/<platform>/packer_cache/watchdog/`.
`agent-dev-env watch-build <vnc-port> [outdir]` runs the same watchdog in
the foreground (with hard errors for missing prerequisites).

### Template variables

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `windows_version` | string | — | Windows guest version, e.g. `11`; part of the image name (`sandbox-windows-<windows_version>-arm64-qemu` / `-arm64-vmware`) |
| `image_version` | string | — | Semantic version this image is published under; bump it + add a `CHANGELOG.md` entry per release |
| `iso_path` | string | — | Absolute path to the Windows 11 ARM64 ISO (set by the build flow, not in the vars file) |
| `iso_sha256` | string | `` | SHA256 of the Windows ISO (verified by the build flow; empty = skip) |
| `virtio_win_iso_path` | string | — | Path to virtio-win.iso (set by the build flow) |
| `virtio_win_url` | string | stable URL | Download URL used by the build flow when `VIRTIO_WIN_ISO_PATH` is unset |
| `virtio_win_sha256` | string | `` | SHA256 of virtio-win.iso (verified by the build flow; empty = skip) |
| `nodejs_version` / `nodejs_sha256` | string | pinned | Node.js version + SHA256 of `node-v<version>-win-arm64.zip` (the official win-arm64 build — choco's `nodejs` is x64, which runs under emulation and crashes opencode's native path) |
| `python_version` / `python_sha256` | string | pinned | Python version + SHA256 of `python-<version>-arm64.exe` (official win-arm64 installer) |
| `github_cli_version` / `github_cli_sha256` | string | pinned | GitHub CLI version + SHA256 of `gh_<version>_windows_arm64.zip` |
| `git_version` / `git_sha256` | string | pinned | Git version + SHA256 of `Git-<version>-arm64.exe` (Git for Windows win-arm64 installer) |
| `firefox_version` / `firefox_sha256` | string | pinned | Firefox version + SHA256 of `Firefox Setup <version>.exe` (win64-aarch64) |
| `go_version` / `go_sha256` | string | pinned | Go version + SHA256 of `go<version>.windows-arm64.zip` |
| `jdk_version` / `jdk_sha256` | string | pinned | JDK version + SHA256 of the Adoptium win-aarch64 zip (choco's `temurin21` is x64) |
| `ripgrep_version` / `jq_version` | string | pinned | Choco package versions (no win-arm64 builds exist; they run emulated) |
| `open_code_review_version` | string | pinned | `ocr` version installed via npm |
| `disk_size` | number | `100` | VM disk size in GB |
| `cpu_count` | number | `4` | CPU count of the VM |
| `memory_gb` | number | `8` | RAM of the VM in GB |
| `winrm_username` | string | `Administrator` | WinRM provisioning user; must match `autounattend.xml` |
| `winrm_password` | string | `sandbox1` | WinRM provisioning password; must match `autounattend.xml` |
| `openchamber_ui_password` | string | `sandbox` | Password protecting the OpenChamber web UI |
| `openchamber_port` | number | `4000` | TCP port of the OpenChamber web UI in the guest |
| `openchamber_desktop_version` / `openchamber_desktop_sha256` | string | pinned | OpenChamber desktop app version + SHA256 of the win-arm64 NSIS installer |
| `qemu_binary` | string | `./qemu-with-tpm.sh` | qemu binary (or wrapper) Packer invokes |
| `efi_firmware_code` / `efi_firmware_vars` | string | Homebrew edk2 AAVMF | UEFI firmware paths (read-only code + NVRAM template) |
| `vnc_bind_address` / `vnc_port_min` / `vnc_port_max` | string/number | `127.0.0.1` / `5901` / `5901` | VNC server for the build watchdog (pinned so `build` can start it without scanning for the port) |

### Publishing

The macOS images are pushed with `tart push`; the Windows images are plain
files (qcow2 / vmx+vmdk tar.gz), so `deploy` splits them into 512 MiB
chunks and pushes them to GHCR as OCI artifacts with `oras` (one layer
per chunk; the pull fetches chunks individually, so an interrupted pull
only re-fetches the missing ones):

```bash
# From the repository root; needs `brew install oras` and a GHCR token
# with write:packages (`oras login ghcr.io`)
pnpm agent-dev-env deploy sandbox-windows-11-arm64-qemu
pnpm agent-dev-env deploy sandbox-windows-11-arm64-vmware
```

This pushes `ghcr.io/<owner>/<image>:<image_version>` and `:latest` for
each. Consumers pull the chunks into their state dir when no local build
output exists — `agent-dev-env run windows-qemu` assembles the qcow2 from
them (and deletes the chunks), the VMware runner extracts the tar.gz
stream directly from the chunks. Both directions retry transient
failures with bounded backoff (`lib/retry.ts`); an interrupted command
(Ctrl+C) is never retried.

## Ubuntu images

### How they are built

`images/ubuntu-arm64-vmware/sandbox.pkr.hcl` reuses the
[vmware-iso mechanics of the Windows VMware image](#vmware-images-imageswindows-arm64-vmware)
(Fusion on Apple Silicon, `guest_os_type "arm-ubuntu-64"`, hardware
version 20, NVMe disk, vmxnet3 NIC under NAT, EFI firmware, headless with
VNC pinned to 5901) with a Linux installer: Ubuntu Server 24.04 ARM64 is
autoinstalled by Subiquity, not unattended:

1. **The boot is typed by the build watchdog, not the Packer
   boot_command.** The firmware's No-Media/PXE probe cycle before grub
   appears is variable-length (measured 20-40 s on Fusion), so plugin
   typing fired before grub was up and the menu's default entry booted
   the interactive installer. `assets/watchdog/watch-build.py` (with the
   `WATCH_BUILD_BOOT_CMD` env var, rendered by the ubuntu-vmware flow)
   detects the grub menu/shell in the VNC OCR and types the autoinstall
   kernel line `linux /casper/vmlinuz autoinstall
   ds=nocloud-net;s=http://<vmnet8-host>:8004/ ---` (the seed server is
   `python3 -m http.server 8004` over `autoinstall/`, started by the
   build flow; the plugin's own http_directory uses a random port and
   does not accept an `http_port` override). While the command is untyped
   the watchdog polls every 3 s — grub's menu countdown is only ~20 s
   wide, and the watchdog's slow cadence (90 s worker + 20 s sleep ≈ one
   frame per ~2 min) could miss the menu so completely that the
   interactive Subiquity installer booted and the build hung on "Timeout
   waiting for SSH" (observed on 2026-08-29); once `.boot-typed` exists
   (or after a 4 min cap) the slow cadence resumes. Subiquity then
   configures LVM over the whole disk, user `admin` (password hash — keep
   in sync with `ssh_password` in the vars file), openssh-server with
   password auth, open-vm-tools — and reboots into the installed system.
2. **No Fusion driver/tools staging** — the vmxnet3 NIC driver ships in
   Ubuntu's base `linux-modules` package (verified for 24.04 arm64; NVMe
   is in-box too), and Fusion ships *no* Linux tools ISO for arm64 guests
   (`isoimages/arm64/` has only `windows.iso`), so open-vm-tools come from
   the Ubuntu archive. open-vm-tools are what make `vmrun
   getGuestIPAddress` and HGFS work at runtime.
3. **Provisions over SSH** — the same toolchain story as the other
   sandboxes: apt base toolchain (build-essential, git, curl, jq,
   ripgrep, vim, tmux, socat, python3, ruby; browser/X libs), hash-pinned
   direct downloads (GitHub CLI deb, Go tarball, VS Code deb, Chrome for
   Testing zip, Firefox release tarball, Docker CLI + compose + buildx
   static binaries), nvm (Node), rustup (Rust), OpenCode V2 (the official
   V2 installer), and npm globals (ocr, @openchamber/web). The guest also
   ships a desktop:
   `ubuntu-desktop-minimal` + `open-vm-tools-desktop`, `graphical.target`
   as the default boot target and GDM3 auto-login as `admin` (Xorg
   session — software rendering, a Fusion arm64 guest has no GPU accel).
   OpenChamber runs as a systemd **user** service
   (`agent-dev-env-openchamber`) on `0.0.0.0:4000` with
   `loginctl enable-linger` — the Linux equivalent of the macOS
   LaunchAgent / Windows ONLOGON task.
4. **Leaves a runnable vmx + vmdk** at
   `~/Library/Application Support/agent-dev-env/build/ubuntu-vmware/output/sandbox-ubuntu-24-04-arm64-vmware.vmx`
   (disk type 0, monolithic sparse; no build-time snapshot — the runner
   makes a full `vmrun clone` as the working VM). `build` then upgrades
   the VM to the hardware version the installed Fusion writes for a new VM
   (`vmrun upgradevm` — same rationale as the Windows image).

The runtime side is `agent-dev-env run ubuntu-vmware` — same mechanics as
the Windows VMware runner (NAT + vmnet8, guest IP via open-vm-tools, no
port forwarding), with Linux guests: the bridges are systemd **user**
services (installed by the bundled `guest-agent-ubuntu`, services persist
via linger), the shared folder mounts at `/mnt/hgfs/work`, and the runner
also installs the sandbox agent rules (`assets/rules/agent-rules-linux.md`).
Bridge ports: SSH agent **4400**, Docker **4401** (macOS 4100/4101, QEMU
4200/4201, Windows VMware 4300/4301 — all four sandboxes can run side by
side).

### Building an image

```bash
# From the repository root; the ISO is required
UBUNTU_ISO_PATH=/path/to/ubuntu-24.04.4-live-server-arm64.iso \
  pnpm agent-dev-env build sandbox-ubuntu-24-04-arm64-vmware
```

The ubuntu-vmware flow verifies the ISO against `iso_sha256` from the vars
file, serves the autoinstall seed on port 8004, types the grub command via
the VNC build watchdog (vmnet8 subnet from Fusion's dhcpd.conf), runs
`packer init` + `packer build`, and upgrades the output VM with `vmrun
upgradevm`. A build takes roughly 20 minutes on an M-series Mac; everything
per image lives in `~/Library/Application Support/agent-dev-env/build/ubuntu-vmware/`.

### Template variables

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `ubuntu_version` | string | — | Ubuntu guest version, e.g. `24-04`; part of the image name (`sandbox-ubuntu-<ubuntu_version>-arm64-vmware`) |
| `image_version` | string | — | Semantic version this image is published under; bump it + add a `CHANGELOG.md` entry per release |
| `iso_path` | string | — | Absolute path to the Ubuntu Server ARM64 ISO (set by the build flow, not in the vars file) |
| `iso_sha256` | string | `` | SHA256 of the Ubuntu ISO (verified by the build flow; empty = skip) |
| `ssh_username` | string | `admin` | SSH provisioning user; must match `autoinstall/user-data` |
| `ssh_password` | string | `sandbox1` | SSH provisioning password; must match the crypt hash in `autoinstall/user-data` |
| `node_version` / `python_version` | string | `26` / `3.12` | Node major (nvm) and Python `python3.<minor>` archive package versions |
| `github_cli_version` / `go_version` / `rust_version` / `vscode_version` / `chrome_version` / `firefox_version` / `open_code_review_version` | string | pinned | Pinned toolchain versions (+ SHA256 vars for the direct downloads) |
| `docker_version` / `docker_compose_version` / `docker_buildx_version` | string | pinned | Docker CLI + plugin versions (+ SHA256 vars) |
| `disk_size` | number | `100` | VM disk size in GB |
| `cpu_count` | number | `4` | CPU count of the VM |
| `memory_gb` | number | `8` | RAM of the VM in GB |
| `openchamber_ui_password` | string | `sandbox` | Password protecting the OpenChamber web UI |
| `openchamber_port` | number | `4000` | TCP port of the OpenChamber web UI in the guest |
| `openchamber_desktop_version` / `openchamber_desktop_sha256` | string | pinned | OpenChamber desktop app version + SHA256 of the linux-arm64 AppImage |

### Publishing

Same as the Windows VMware image: `deploy` packs the output directory into
a tar.gz, splits it into 512 MiB chunks and pushes them to GHCR as an OCI
artifact with `oras`:

```bash
# From the repository root; needs `brew install oras` and a GHCR token
# with write:packages (`oras login ghcr.io`)
pnpm agent-dev-env deploy sandbox-ubuntu-24-04-arm64-vmware
```

This pushes `ghcr.io/<owner>/<image>:<image_version>` and `:latest`.
Consumers pull the chunks into their state dir when no local build output
exists (`agent-dev-env run ubuntu-vmware` extracts the chunks).

## Adding a new platform

To add a new host/guest combination (e.g. macOS host → FreeBSD guest),
create a new `images/<platform>/` directory following the macOS pattern:

1. Packer template with the appropriate builder (e.g. QEMU, or the
   [qocker](https://github.com/AdGuardSoftwareLimited/qocker) Vmfile approach
   for layered Linux images). If the platform needs host-side preparation
   that plain `packer build` cannot do (like the Windows ISO staging and
   swtpm), extend the CLI's lifecycle with a `build-<platform>.ts` flow —
   `lifecycle/build.ts` dispatches to it automatically by platform
   metadata (`lib/platform.ts`). If it needs a different push mechanism
   (like the Windows qcow2 vs Tart VMs), extend `lifecycle/deploy.ts`.
2. `vars/` image files + a `CHANGELOG.md` (the CLI's catalog picks up the
   new image automatically), following the version/tag conventions in
   AGENTS.md.
3. A short per-platform `README.md` with build/publish commands.
4. Update this document with the platform's build and publish
   instructions.

## Housekeeping

- Keep the "What's in the image" tables in [docs/macos.md](docs/macos.md)
  (and the platforms' `README.md`, e.g.
  [images/ubuntu-arm64-vmware/README.md](images/ubuntu-arm64-vmware/README.md)
  and [docs/ubuntu-vmware.md](docs/ubuntu-vmware.md)) in sync with the
  templates.
- Test every image change locally before pushing — a broken image costs a
  ~1-hour rebuild.
- Naming, release tags, and changelog rules are project conventions —
  see AGENTS.md.
