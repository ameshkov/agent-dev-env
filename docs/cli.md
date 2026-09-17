# agent-dev-env CLI reference

This is the reference for the `agent-dev-env` CLI — the single tool that
builds, runs, and wires up the sandbox VMs (macOS via Tart, Windows 11
ARM64 via QEMU or VMware Fusion, Ubuntu 24.04 ARM64 via VMware) and
manages their image releases on GHCR. The per-platform guides
([macOS](macos.md), [Ubuntu](ubuntu-vmware.md),
[Windows QEMU](windows-qemu.md), [Windows VMware](windows-vmware.md)) cover
prerequisites and day-to-day usage; this document covers everything the CLI
accepts.

## Installation

The CLI is distributed as the `agent-dev-env` npm package. Use it once
without installing:

```bash
npx agent-dev-env --help
```

or install it globally:

```bash
npm install -g agent-dev-env
agent-dev-env --help
```

Pre-release builds from the `master` branch are published to the npm
`canary` dist-tag after every push (version
`<version>-canary.<run>.<sha>`):

```bash
npm install -g agent-dev-env@canary
```

Contributors working in the repo can run the in-tree CLI after a build
(`pnpm build`) with the root `agent-dev-env` script:

```bash
pnpm agent-dev-env --help
```

Runtime requirements (host, macOS only):

- macOS (Apple Silicon only — Tart/QEMU/Fusion cannot virtualize ARM64
  guests on Intel).
- Node.js 26+.
- Per-platform tooling: [Tart](https://tart.run/) for `macos`
  (`brew install cirruslabs/cli/tart`), QEMU + swtpm for `windows-qemu`
  (`brew install qemu swtpm`), VMware Fusion for `windows-vmware` /
  `ubuntu-vmware` (no brew step — `vmrun` lives inside the app bundle),
  and [oras](https://oras.land/) for pulling images from GHCR
  (`brew install oras`).

`agent-dev-env doctor` checks all of this (see
[doctor](#doctor-prerequisite-and-disk-check)).

## Command overview

```text
agent-dev-env run <platform> [options]     # macos | windows-qemu | windows-vmware | ubuntu-vmware
agent-dev-env start <platform> [options]   # alias of run
agent-dev-env stop <platform>
agent-dev-env delete <platform> [--yes] [--pristine]   # --pristine: also the image cache
agent-dev-env sync <platform> [--yes]                  # macos | ubuntu-vmware
agent-dev-env status [platform]           # live status of one or all platforms
agent-dev-env list                        # bundled images: name, platform, image_version
agent-dev-env build [image...] [--force] [--no-watchdog]
agent-dev-env deploy [image...] [--owner OWNER]
agent-dev-env tag [image...]              # git-backed; needs a repo checkout
agent-dev-env doctor [--platform P]       # prereq + disk check
agent-dev-env watch-build <vnc-port> [outdir]          # hidden
```

## run

`start` is an alias of `run` — both spellings take the same arguments,
options, and behavior.

Starts — and automatically wires up — the chosen sandbox VM. On first use
it picks the image (local build output first, then asks to pull `:latest`
from GHCR via `oras` in 512 MiB chunks — every chunk fetch is retried
with bounded backoff, and an interrupted pull keeps the chunks it already
downloaded and fetches only the missing ones), creates the working VM,
boots it, bridges the host's
SSH agent and Docker engine into the guest, installs the guest-side agent
(bridges + rules), copies your host user settings where supported
(`macos`, `windows-qemu`, `windows-vmware`, `ubuntu-vmware`), and verifies
OpenChamber. `--reset` wipes the
working VM and starts fresh from the pristine image; the pristine image is
never written to.

Platform table (defaults unless overridden — see the options/env vars
below):

| | macOS | Windows (QEMU) | Windows (VMware) | Ubuntu (VMware) |
| --- | --- | --- | --- | --- |
| Hypervisor | Tart | QEMU + HVF | VMware Fusion | VMware Fusion |
| Default image | `sandbox-macos-tahoe` | `sandbox-windows-11-arm64-qemu` | `sandbox-windows-11-arm64-vmware` | `sandbox-ubuntu-24-04-arm64-vmware` |
| Default instance | `default-agent-dev-env` | `default-agent-dev-env` | `default-agent-dev-env` | `default-agent-dev-env` |
| Shared host dir | `--work-dir` (Tart mount) | — | skipped (unsupported for Win11 ARM) | `--work-dir` (HGFS) |
| Settings copy | yes | yes | yes | yes |
| Agent rules | yes | — | — | yes |
| Guest access | NAT IP:4000 | `127.0.0.1:2222` / `3389` / `4000` | NAT IP:22 / `3389` / `4000` | NAT IP:22 / `4000` |
| Agent bridge port | `4100` | `4200` | `4300` | `4400` |
| Docker bridge port | `4101` | `4201` | `4301` | `4401` |
| CPUs / RAM (default) | 8 / 16 GB | 4 / 8 GB | 4 / 8 GB | 4 / 8 GB |

Options:

- `--headless` — run without a window (`tart run --no-graphics` /
  `-display none` / Fusion `nogui`); on macOS system shortcuts are only
  captured into the guest in windowed runs.
- `--foreground` — keep the terminal attached and block until the VM
  stops (Cmd+C in the terminal stops it). Default is background: the
  command exits after the summary and the VM keeps running
  (`agent-dev-env stop <platform>` to stop it, `delete` to remove it;
  logs under the logs root, see [Paths](#paths)).
- `--no-agent` — skip the SSH agent bridge setup.
- `--no-docker` — skip the Docker engine bridge setup.
- `--no-settings` — skip copying the host user settings into the guest
  (all four platforms).
- `--work-dir <path>` — host directory to share into the guest; overrides
  `SANDBOX_WORK_DIR`. macOS mounts it under
  `/Volumes/My Shared Files/<mount-name>`; Ubuntu under
  `/mnt/hgfs/work`. Skipped with a warning for `windows-vmware`
  (unsupported for Windows 11 ARM guests).
- `--reset` — delete the working VM state (working clone / COW overlay /
  TPM / EFI NVRAM) and start fresh from the pristine image. Everything
  inside the guest is lost; the pristine image cache (shared across
  instances) is kept.
- `--image <image>` — pristine image to pull/clone from
  (`SANDBOX_IMAGE`).
- `--owner <owner>` — GHCR owner for pulls (`GHCR_OWNER`; defaults to
  the git remote, then `ameshkov`).
- `--yes` — skip confirmation prompts.

### Sandbox instances

Every platform runs sandboxes as *instances* of a pristine image: the
image is downloaded/extracted once into a shared cache
(`<data>/<platform>/<image>/image/…`), and each instance gets its own
working state (`working/<instance>/`: the VMware clone or QEMU COW
overlay + TPM + EFI NVRAM, pidfiles, and provenance records). The
instance name is set via `SANDBOX_VM` (default
`default-agent-dev-env`) and must be strict kebab-case
(`[a-z0-9][a-z0-9-]*`) — it is a path segment and a Tart VM name, so no
dots, slashes, or uppercase.

```bash
SANDBOX_VM=project-a agent-dev-env run ubuntu-vmware
SANDBOX_VM=project-b agent-dev-env run ubuntu-vmware   # side by side
```

`run`/`stop`/`delete`/`sync`/`status` all resolve the instance through
the same `SANDBOX_VM` env var, so one export describes one sandbox:

```bash
export SANDBOX_VM=project-a
agent-dev-env run macos
agent-dev-env status macos
agent-dev-env stop macos
```

With no `SANDBOX_VM` set, `status` lists every instance that has working
state. Because the host bridge ports are per-platform, two instances of
the same platform running at once need distinct ports — the bridge setup
refuses to reuse a bridge owned by a different instance and tells you
which `SANDBOX_*_PORT` to override (see the env table).

The runner prints a live status line (bridges + OpenChamber) while it
works, then a summary: VM/Guest IP, shared directory, SSH agent and Docker
state, and the OpenChamber URL. After a run, the host-side bridges stay up
until `stop` (or the next `run`).

## stop

Stops the sandbox VM and kills the host bridges the runner left up.

- macOS: `tart stop` (graceful, with the legacy wait-for-stopped flow);
- QEMU: qemu via the runner's `qemu.pid` (with the overlay-path `pgrep`
  fallback), then swtpm;
- VMware: `vmrun -T fusion stop` gracefully, hard power-off fallback after
  a minute.

The guest-side bridges (launchd / systemd / ONLOGON task) stop with the VM.
Start the sandbox again with `run`.

## delete

Stops the sandbox first, then removes it:

- macOS: `tart delete` the working VM; with `--pristine` (or `--yes` at
  the pristine prompt, default no) the pristine image is deleted too.
- QEMU / VMware: removes the instance's state dir under the data root
  (`working/<instance>/`: the extracted base's working clone, or the
  overlay with its TPM and EFI NVRAM). The next run re-clones the
  instance. Fusion's VM library may still list the deleted working VM —
  remove the stale entry in the Fusion UI (harmless).

The shared pristine image cache (the pulled image plus the extracted
base) follows these rules:

- The last instance's deletion drops the cache with it.
- `--pristine` drops the cache explicitly, including when no instance
  state is left to delete (e.g. a failed first pull left only chunks
  behind).
- With another instance remaining the cache is kept instead: a QEMU
  working disk is a COW overlay backed by the pristine qcow2, and a
  VMware re-clone needs the cache. The command says so.
- The delete summary reports whether the cache was removed or where it
  was kept.

Options:

- `--yes` — do not ask for confirmation.
- `--pristine` — also delete the pristine image (macOS) / the shared
  image cache (QEMU, VMware).

## sync

Copies the host's user settings into the guest on demand (all four
platforms) — the same files the runner copies, always, regardless of
the version marker. The VM must be running (start it with `run` first). It
restarts OpenChamber so the new settings take effect, and updates the
guest's settings marker so the runner won't re-offer the copy on its next
run. `--yes` skips the confirmation prompt.

The Ubuntu, macOS and Windows copies also write the host's
`OPENCODE_MODELS_URL` into the guest when it is set: opencode resolves
model IDs against a model registry fetched from
`${OPENCODE_MODELS_URL}/api.json` (the models.dev format), and a custom
registry is what makes a private provider's models (e.g. `tokenguard/*`)
resolve in the guest. Ubuntu points the OpenChamber systemd user service
at a guest env file (a drop-in with `EnvironmentFile=`) and sources it
from the login shells; macOS sources the same guest env file from
`~/.zprofile`/`~/.zshrc`, and the OpenChamber restart re-snapshots the
LaunchAgent environment from it. Neither needs a reboot. Windows applies
a user environment variable only to processes started afterwards, so the
sync then offers to reboot the guest (default: yes) — the reboot makes
sure OpenChamber and opencode pick it up. Declining leaves the guest
running; reboot it before relying on the variable. With `--yes` the
reboot offer is accepted without asking.

## status

Live status of one or all platforms: the image, whether the pristine /
working state exists, and the running state (Tart VM state, qemu pidfile
with a pgrep fallback, VMX existence + guest IP where available). It also
surfaces image provenance where recorded — the `image source:` line (the
GHCR ref + digest the image was pulled from) and the `clone source:` line
(what the working VM was cloned from, when, and whether the record was
backfilled for a VM cloned before provenance tracking).

`status` resolves the sandbox instance from `SANDBOX_VM` (default
`default-agent-dev-env`), like `run`/`stop`/`delete`/`sync`; with
`SANDBOX_VM` unset it additionally lists every instance with working
state, one `VM:` line per instance. With no argument it summarizes all
platforms; `status <platform>` narrows to one.

## list

Prints the images the CLI knows about (from the bundled
`dist/assets/images/*/vars/*.pkrvars.hcl` snapshot — the same images that
ship inside the npm package): name, platform, `image_version`.

## build

Builds sandbox images with Packer. Without arguments it builds every
image; pass image names to build a subset (e.g.
`agent-dev-env build sandbox-macos-tahoe windows-qemu`).

- macOS: plain `packer init` + `packer build -var-file`.
- windows-qemu: ISO + ARM64 virtio driver staging (`hdiutil`), swtpm,
  `qemu-with-tpm.sh` wrap, VNC watchdog, zstd compression of the output.
- windows-vmware: vmxnet3 driver staging from Fusion's `drivers-arm64.zip`,
  hardware upgrade of the artifact.
- ubuntu-vmware: autoinstall seed server on port 8004, watchdog-typed grub
  boot, hardware upgrade.

Outputs land under `<data>/build/<platform>/` (see [Paths](#paths)), and
the per-platform flows need `WINDOWS_ISO_PATH` / `UBUNTU_ISO_PATH` (the
ISO is bring-your-own; the CLI verifies its SHA256 from the vars file) and
— for VMware — Fusion.

Options:

- `--force` — force a rebuild (`packer -force`).
- `--no-watchdog` — skip the VNC build watchdog (it needs `vncdotool` +
  the Xcode command-line tools; builds skip it with a warning when they
  are missing).

## deploy

Pushes locally built images to GHCR after confirming the image and owner.
Without arguments it deploys every image; pass image names to deploy a
subset. `agent-dev-env deploy --help` lists the available images (the
same catalog `build --help` shows):

- macOS: `tart push --chunk-size 3` — version tag + `:latest`;
- windows-qemu: split the qcow2 into 512 MiB chunks and `oras push`
  them, one OCI layer per chunk, as the
  `application/vnd.agent-dev-env.qcow2` artifact;
- windows-vmware / ubuntu-vmware: pack the output into a tar.gz (vmx,
  nvram, vmdk; logs excluded), split it into 512 MiB chunks and
  `oras push` them, one OCI layer per chunk, as
  `application/vnd.agent-dev-env.vmware-vm`.

Every chunk layer carries the `application/vnd.agent-dev-env.image-part`
media type; the pull fetches chunks individually and re-fetches only the
missing or truncated ones (a single 22 GiB layer dies when GHCR's signed
download URL expires mid-transfer). Chunked images are only readable by
CLIs that understand the chunk layout — images published the old way must
be re-deployed.

Every chunk fetch and push is retried with bounded exponential backoff
(`lib/retry.ts`): the manifests, each `oras blob fetch`, the chunked
`oras push`, and macOS `tart pull`/`tart push`. Content-addressed blobs
make a retried transfer resume instead of restarting, and a Ctrl+C
interrupt is never retried.

Owner resolution: `GHCR_OWNER` env → `--owner` flag → git remote setup
(inside a checkout) → default `ameshkov`. Images live flat as
`ghcr.io/<owner>/<image>`.

Options:

- `--owner <owner>` — GHCR owner override.

## tag

Creates and pushes the annotated git release tag for an image, reading
`image_version` from the image's vars file and requiring the matching
`## [<tag>]` entry in the platform's `images/<platform>/CHANGELOG.md`
(the `<platform>-v<version>` convention, e.g. `mac-v1.2.0`). Gates: clean
worktree, tag not existing, changelog entry present. Runs from the current
checkout; `--repo <path>` overrides it. This needs a checkout of this
repository — without one it errors clearly.

## doctor

Prerequisite + disk check: host macOS, Apple Silicon, free disk (against
the images' `disk_size` vars plus the build overhead — the ~70 GB macOS
base image, ~50 GB for the file-based builds), and per-platform tooling
(tart, packer, qemu/qemu-img/swtpm, vmrun, oras) with install hints.
`--platform <platform>` narrows the check to one platform (without it, all
platforms).

## watch-build

Hidden command (`agent-dev-env watch-build <vnc-port> [outdir]`): the
foreground VNC build watchdog — polls the VNC framebuffer at the given
port, OCRs each frame with the bundled Swift helper (compiled if stale),
and answers the boot/quit prompts. Hard-errors when `vncdotool` or the
Swift compiler is missing (unlike `build`, which warns and skips).

## Environment variables

`SANDBOX_*` variables remain as fallback defaults — flags always win —
so existing invocations keep working:

| Variable | Default | What it does |
| --- | --- | --- |
| `SANDBOX_IMAGE` | per platform | Pristine image to pull/clone from (`--image`) |
| `SANDBOX_VM` | `default-agent-dev-env` | Sandbox instance name — one working VM/state per name, all platforms |
| `SANDBOX_WORK_DIR` | per platform | Host directory shared into the guest; empty disables the mount |
| `SANDBOX_MOUNT_NAME` | `dev` | Mount name in the guest (macOS: `/Volumes/My Shared Files/<name>`) |
| `SANDBOX_AGENT_PORT` | `4100`/`4200`/`4300`/`4400` | TCP port for the SSH agent bridge |
| `SANDBOX_DOCKER_PORT` | `4101`/`4201`/`4301`/`4401` | TCP port for the Docker engine bridge |
| `SANDBOX_OPENCHAMBER_PORT` | `4000` | Guest port of OpenChamber |
| `SANDBOX_SSH_PORT` | `2222` | Host port forwarded to guest SSH (`windows-qemu`) |
| `SANDBOX_RDP_PORT` | `3389` | Host port forwarded to guest RDP (`windows-qemu`) |
| `SANDBOX_WINRM_PORT` | `5985` | Host port forwarded to guest WinRM (`windows-qemu`) |
| `SANDBOX_CPU_COUNT` | per platform | CPUs for a freshly created working VM |
| `SANDBOX_MEMORY_MB` | per platform | RAM for a freshly created working VM, in MB |
| `WINDOWS_IMAGE` | — | Path to a local `sandbox-windows-11-arm64-qemu.qcow2` to run instead of the discovered/pulled one |
| `WINDOWS_VMWARE_IMAGE` | — | Local Windows image: a chunked image directory or a tar.gz of the VM dir (split into cached chunks on first use) |
| `UBUNTU_VMWARE_IMAGE` | — | Local Ubuntu image: a chunked image directory or a tar.gz of the VM dir (split into cached chunks on first use) |
| `WINDOWS_PASSWORD` | from the vars file | Administrator password in the Windows guest |
| `UBUNTU_PASSWORD` | from the vars file | `admin` password in the Ubuntu guest |
| `FUSION_APP_PATH` | `/Applications/VMware Fusion.app` | VMware Fusion install location |
| `WINDOWS_ISO_PATH` | — | Windows 11 ARM64 ISO (build) |
| `VIRTIO_WIN_ISO_PATH` | — | virtio-win.iso (build; downloaded into the cache otherwise) |
| `UBUNTU_ISO_PATH` | — | Ubuntu Server ARM64 ISO (build) |
| `GHCR_OWNER` | git remote → `ameshkov` | GHCR owner for pulls/pushes |
| `NO_COLOR` | unset | Any non-empty value disables colored output |

Path overrides (see [Paths](#paths)): `AGENT_DEV_ENV_DATA_HOME`,
`AGENT_DEV_ENV_LOG_DIR`, `AGENT_DEV_ENV_CACHE_DIR` — and the `XDG_DATA_HOME`
/ `XDG_STATE_HOME` / `XDG_CACHE_HOME` equivalents (when explicitly set).

## Paths

State lives under the XDG-aware `agent-dev-env` roots (designed from
scratch — no legacy paths, no migration):

| Role | macOS | Linux |
| --- | --- | --- |
| Data (images, working VM state, build outputs) | `~/Library/Application Support/agent-dev-env` | `~/.local/share/agent-dev-env` |
| Logs / runtime state | `~/Library/Logs/agent-dev-env` | `~/.local/state/agent-dev-env` |
| Cache (watchdog frames, downloaded ISOs) | `~/Library/Caches/agent-dev-env` | `~/.cache/agent-dev-env` |

Data layout:

```text
<data>/
  build/<platform>/            packer build outputs (built image + packer_cache
                               + staged drivers; deploy consumes these)
  build-context/<platform>/    materialized packer context (writable copy of
                               images/<platform>)
  macos/<image>/               provenance records only (working/<instance>/clone.json
                               + image.json; Tart owns the VM itself)
  windows-qemu/<image>/        image/ (pristine qcow2), working/<instance>/ (overlay,
                               efivars.fd, tpm/, pids, sockets, clone.json),
                               image.json
  windows-vmware/<image>/      image/, base/, working/<instance>/, provenance records
  ubuntu-vmware/<image>/       image/, base/, working/<instance>/, provenance records
```

- macOS has no VM-state footprint: Tart owns the pristine image and the
  working VM; only the provenance records and the logs root (`tart-*.log`)
  are the CLI's.
- The pristine image cache (`image/`, `base/`) is shared across all
  instances of an image — one download/extraction serves every
  `SANDBOX_VM`. Each instance's mutable state lives in
  `working/<instance>/`.
- Provenance records (`clone.json` + `image.json`) are best-effort and
  never fatal — see
  `packages/agent-dev-env-cli/src/lib/provenance.ts`; `status` and the run
  summaries surface them.
- Guest-side markers live under `~/.config/agent-dev-env/` (settings
  version, agent-rules sha256, the baked image identity `image.json`).
- No host config file in v1 — env vars and flags only. `XDG_CONFIG_HOME`
  is a documented future hook.
