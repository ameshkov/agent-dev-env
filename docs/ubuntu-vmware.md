# Set up an Ubuntu VMware sandbox (Apple Silicon)

> **What you'll get.** A local sandbox virtual machine: an Ubuntu 24.04 LTS
> (ARM64) server guest with a full coding toolchain and an AI coding agent
> (OpenCode) pre-installed, plus the OpenCodeReview code-review CLI and the
> OpenChamber web UI to run and supervise agent sessions from your host
> browser — running under VMware Fusion on your Apple Silicon Mac. A host
> directory can be shared into the guest (`SANDBOX_WORK_DIR` or
> `--work-dir`), and the guest is reachable directly at its NAT IP (no port
> forwarding).
>
> **Quick setup** — three steps and you're done:
>
> 1. [Install VMware Fusion](#1-install-vmware-fusion)
> 2. [Run the sandbox](#2-run-the-sandbox)
> 3. [Use the sandbox](#3-use-the-sandbox)
>
> Everything below the **Details** divider is optional reading: what's inside
> the image and how the pieces fit together.

## Which sandbox?

This is the Ubuntu (Linux) variant. It exists alongside the macOS and
Windows sandboxes:

| | Ubuntu (this guide) | macOS | Windows 11 (QEMU) | Windows 11 (VMware) |
| --- | --- | --- | --- | --- |
| Hypervisor | VMware Fusion (free) | Tart | QEMU + HVF | VMware Fusion (free) |
| Guest | Ubuntu 24.04 LTS (ARM64) server | macOS (Apple Silicon) | Windows 11 Pro ARM64 | Windows 11 Pro ARM64 |
| Shared host folder | Yes (HGFS, `SANDBOX_WORK_DIR` / `--work-dir`) | Yes | No | Yes (HGFS, `SANDBOX_WORK_DIR` / `--work-dir`) |
| Guest desktop | Yes (GNOME, auto-login; Fusion window) | Yes | Yes (RDP) | Yes (RDP) |
| Publish artifact | vmx + vmdk (tar.gz) | Tart VM | qcow2 | vmx + vmdk (tar.gz) |

Pick Ubuntu when you want a native Linux agent environment with the full
open-source toolchain (gcc, cmake, Go, Rust, Node, Python, Ruby) and no
Windows/macOS overhead; see the [macOS guide](macos.md),
[Windows QEMU guide](windows-qemu.md) and
[Windows VMware guide](windows-vmware.md) for the other guests.

## Quick setup

### Prerequisites

- An Apple Silicon Mac (M1 or newer). Fusion cannot virtualize ARM64 guests
  on Intel, so this sandbox is ARM64-only.
- [VMware Fusion](https://www.vmware.com/products/desktop-hypervisor/workstation-and-fusion)
  (free for personal use; the image is built against Fusion 13.6+).
- ~35 GB of free disk space (the image is ~15 GB, the working clone grows on
  top).

### Default account

Every sandbox guest has a single local user, used for SSH:

| User | Password |
| --- | --- |
| `admin` | `sandbox1` |

### 1. Install VMware Fusion

Download and install Fusion from the link above (free for personal use —
create a free Broadcom account if prompted). No license key is needed for
personal use. The runner talks to it through `vmrun`, which is inside the
app bundle — no `brew` step.

### 2. Run the sandbox

The [`agent-dev-env`](../docs/cli.md) CLI extracts the image, clones a
working VM, and wires up the bridges. Run it once without installing it:

```bash
npx agent-dev-env run ubuntu-vmware
```

or install the CLI globally (`npm install -g agent-dev-env`) and use
`agent-dev-env run ubuntu-vmware` everywhere below. On first use it picks
the image archive: the local build output
(`~/Library/Application Support/agent-dev-env/build/ubuntu-vmware/...`)
when present, otherwise it asks to pull
`sandbox-ubuntu-24-04-arm64-vmware:latest` from GHCR via
[oras](https://oras.land/) (one-time, ~15 GB — `brew install oras`). It
then extracts the pristine VM (once; the cache is shared across
instances) and clones a working VM per instance under
`~/Library/Application Support/agent-dev-env/ubuntu-vmware/<image>/working/<instance>/`
(the clone's display name in Fusion's library is the instance name —
the base keeps the image's name) — the pristine image is never written to.
On the first clone the CLI
also upgrades the working VM's virtual hardware to the version your
Fusion supports (`vmrun upgradevm`, recorded once per clone) — without it
a newer Fusion shows its one-time "Upgrade this virtual machine?" dialog
on the first windowed start. The guest boots headless or in a Fusion
window (default) — with the GNOME image the window shows the desktop
(auto-login as `admin`), and the CLI discovers its NAT IP via
open-vm-tools:

| Port | Guest service |
| --- | --- |
| 22 | SSH |
| 4000 | OpenChamber web UI |

No port forwarding is needed: the VM sits on Fusion's NAT network
(vmnet8), and the host is that network's router, so the guest IP the CLI
prints is reachable directly from the host. When a Docker engine is
running on the host (Docker Desktop, Colima, OrbStack, ...), the CLI
bridges it into the guest; same for a password-manager SSH agent (see
[Docker (remote engine)](#docker-remote-engine) and
[SSH agent bridge](#ssh-agent-bridge)). The bridges are installed as
systemd user services in the guest, so they survive guest reboots (the
image enables `loginctl enable-linger admin` for exactly this) — no
interactive logon is needed for OpenChamber to come up (see
[OpenChamber from the host](#openchamber-from-the-host)).

Pass `--foreground` to keep the terminal attached (Cmd+C stops the VM),
`--headless` to run without a window, `--no-agent` / `--no-docker` to
skip a bridge, `--no-settings` to skip the host user-settings copy,
`SANDBOX_WORK_DIR` (or `--work-dir /path`) to share a host folder, or
`--reset` to wipe the working VM and start fresh from the pristine image.

> [!NOTE]
> The working VM is your sandbox: installs, config, and agent state
> accumulate in the clone and survive restarts. `--reset` deletes the
> clone — everything inside the guest is lost; the pristine image is not
> touched.

The CLI notices when the image itself changes: it records the archive's
modification time and size (not just its path — a rebuild or `oras pull`
replaces the archive at the same path), so the next run after a rebuild or
re-pull asks before re-extracting the pristine VM: the new image requires
a fresh clone, and the old working clone's guest state (installs, config,
agent files) is lost with it. The prompt defaults to *no* — declining
keeps the previous image and the working instances, and the run continues
on them; accept to switch to the new image. With no working instances
nothing is lost and the re-extraction happens silently. `--reset` deletes
the working state right away.

### 3. Use the sandbox

The CLI prints the guest IP (or find it anytime with
`vmrun -T fusion getGuestIPAddress <vmx>`). Everything is set up now —
use it from the host or inside the VM:

- **Browser UI (OpenChamber)**: open `http://<guest-ip>:4000/` on the host
  (default password: `sandbox`) and start or supervise agent sessions — see
  [OpenChamber from the host](#openchamber-from-the-host).
- **Terminal (OpenCode)**: over SSH from the host:

  ```bash
  ssh admin@<guest-ip>
  ```

  Then configure the agent's LLM provider once (see
  [Configure the environment](#configure-the-environment)) and start it:

  ```bash
  opencode
  ```

- **Code review (OpenCodeReview)**: the image ships the `ocr` CLI — see the
  [OpenCodeReview quick start](https://github.com/alibaba/open-code-review#quick-start).
- **Shared folder**: if you shared a host directory (see
  [Shared host folder](#shared-host-folder)), it is available in the guest
  at `/mnt/hgfs/work`. The run summary also prints the exact mapping.
- **Desktop (in the VM window)**: the guest boots to GNOME (auto-login as
  `admin`) — run without `--headless` and the Fusion window is the desktop,
  with VS Code, Firefox and the OpenChamber UI in the guest browser.

### Configure the environment

The coding agent (OpenCode) needs an LLM provider before it can work. Over
SSH, add yours:

```bash
opencode providers login
```

This walks you through the provider setup (API key, model, ...). Once
configured, restart OpenChamber so it picks up the provider:

```bash
systemctl --user restart agent-dev-env-openchamber
```

### Everyday commands

- **Stop the sandbox** — from the host:

  ```bash
  npx agent-dev-env stop ubuntu-vmware
  ```

  This stops the working VM (`vmrun -T fusion stop`, graceful via VM
  tools with a hard power-off fallback) and kills the host SSH agent /
  Docker bridge listeners. Start it again with
  `npx agent-dev-env run ubuntu-vmware`.

- **Reset the sandbox** — wipe the working VM and start from the pristine
  image:

  ```bash
  npx agent-dev-env run ubuntu-vmware --reset
  ```

- **Delete the sandbox** — remove the instance's state (the working
  clone; the shared pristine image cache goes with the last instance) and
  free the disk space:

  ```bash
  npx agent-dev-env delete ubuntu-vmware --yes
  ```

  This stops the working VM first, then removes the instance's state dir
  under `~/Library/Application Support/agent-dev-env/ubuntu-vmware/<image>/working/<instance>/`.
  The next run re-clones the instance. Other instances keep the shared
  pristine image. Without `--yes` it asks
  before deleting. Add `--pristine` to remove the shared pristine image
  cache too — also when an interrupted pull left no instance state behind
  (the cache is kept while another instance remains). Note: Fusion's VM
  library may still list the deleted
  working VM — remove the
  stale entry in the Fusion UI (harmless).

- **Run several sandboxes side by side** — set a distinct `SANDBOX_VM`
  per sandbox (instances share the pristine image, one download) and free
  ports: `SANDBOX_AGENT_PORT` / `SANDBOX_DOCKER_PORT`.

> [!TIP]
> Once a sandbox is configured the way you like it (installed tools,
> provider login, VS Code extensions — everything the working clone
> accumulated), promote it to a *golden image* of your own instead of
> carrying that setup over by hand:
>
> ```bash
> npx agent-dev-env stop ubuntu-vmware
> WORKDIR="$HOME/Library/Application Support/agent-dev-env/ubuntu-vmware/sandbox-ubuntu-24-04-arm64-vmware/working/default-agent-dev-env"
> ( cd "$WORKDIR" && tar -czf "$HOME/sandbox-ubuntu-golden.tar.gz" *.vmx *.nvram *.vmdk )
> UBUNTU_VMWARE_IMAGE="$HOME/sandbox-ubuntu-golden.tar.gz" \
>   npx agent-dev-env run ubuntu-vmware --reset
> ```
>
> The archive must keep the layout the CLI extracts (the vmx and every
> disk it references next to it — the same layout `deploy` publishes), so
> pack the whole working directory. The `--reset` drops the current
> working clone first; the CLI then extracts your golden as the new
> pristine base and clones a fresh working VM from it — without `--reset`
> it asks whether to drop the working instances instead (default no).

### Desktop

The image ships `ubuntu-desktop-minimal` (GNOME Shell + GDM3) and
`open-vm-tools-desktop`. The VM boots to `graphical.target` and GDM3
auto-logs in `admin`, so the Fusion window is on the desktop right away —
run the sandbox without `--headless` to see it. The session runs on Xorg
(`WaylandEnable=false`): a Fusion arm64 guest has no GPU acceleration, and
the open-vm-tools SVGA + input drivers are what the Xorg session uses.
Everything is software-rendered (llvmpipe) — fine for a terminal, VS Code
and the browser, not for 3D. None of the agent plumbing needs the GUI:
SSH, the bridges and OpenChamber behave the same with `--headless`.

---

## Details

### What's in the image

The image is built with [Packer](https://www.packer.io/)'s VMware plugin
(`vmware-iso`) from the official Ubuntu Server 24.04 ARM64 ISO
(bring-your-own, see
[images/ubuntu-arm64-vmware/README.md](../images/ubuntu-arm64-vmware/README.md))
and runs under Fusion via `vmrun`. It ships:

| Software | Version (default image) |
| --- | --- |
| Ubuntu Server | 24.04 LTS (ARM64), point release from the vars file; LVM over the whole disk |
| open-vm-tools | Ubuntu archive (Fusion ships no Linux tools for arm64); guest IP discovery, soft power ops, shared folders |
| GNU toolchain | build-essential (gcc/g++/make), `cmake`, `ninja-build`, autoconf/automake, pkg-config — Ubuntu archive |
| CLI tools | `git` + LFS, `curl`, `wget`, `jq`, `ripgrep`, `vim`, `tmux`, `socat`, `xz-utils`, unzip/zip — Ubuntu archive |
| Python | 3.12 (`python3.12` + pip/venv, from the Ubuntu archive) |
| Ruby | Ubuntu archive (`ruby` + `ruby-dev`; `rbenv` for project-pinned interpreters) |
| Go | 1.27.0 (go.dev/dl tarball, hash-pinned, `/usr/local/go`) |
| Rust | 1.95 (rustup, arm64 host toolchain) |
| Java | 17 (OpenJDK from the archive; `JAVA_HOME` exported via `/etc/profile.d`) |
| Gradle | 8.7 (bin zip hash-pinned to `/opt/gradle`; wrapper distribution pre-cached in `~/.gradle`) |
| Kotlin/Native | Not available — JetBrains publishes no linux-aarch64 prebuilt (macOS x86_64/aarch64 and Linux x86_64 only) |
| Android SDK | `/opt/android-sdk` (cmdline-tools hash-pinned): platform-tools, platforms;android-36, build-tools;36.0.0, NDK 28.2 + `ndk;29.0.14206865` / `build-tools;34.0.0` pre-installed |
| Node.js + npm | 26 (via nvm); npm globals: `pnpm`, `yarn` |
| GitHub CLI | 2.98.0 (linux-arm64 deb, hash-pinned) |
| Visual Studio Code | 1.134.0 (arm64 deb, hash-pinned; `code` on PATH) |
| Firefox | 154.0 (linux-aarch64 tarball, hash-pinned; no Chrome — CfT publishes no linux-arm64 build) |
| Docker CLI | 29.7.2 + `docker compose` 5.5.0 + `docker buildx` 0.36.1 (static aarch64 binaries; client only — remote engine via the host bridge) |
| OpenCode | latest (official installer) |
| OpenCodeReview (`ocr`) | 1.9.5 (npm global) |
| OpenChamber web UI | latest (npm global, systemd user service on `0.0.0.0:4000`, started at boot) |
| OpenChamber desktop app | 1.22.0 (linux-arm64 AppImage, hash-pinned; launch as `openchamber-desktop` or via the GNOME app menu) |
| GNOME desktop | `ubuntu-desktop-minimal` + `open-vm-tools-desktop`; boots to `graphical.target`, GDM3 auto-login as `admin`, Xorg session (software rendering — no GPU accel under Fusion) |
| SSH | openssh-server with password auth; `admin`/sandbox1 (see the vars file) |
| Image identity | `~/.config/agent-dev-env/image.json` (image name + `image_version`, baked at build time) |

Verify the toolchain over SSH (`ssh admin@<guest-ip>`, password `sandbox1`):

```bash
node --version && npm --version
pnpm --version && yarn --version
python3 --version
rbenv --version
git --version
git lfs version
gh --version
rg --version
jq --version
go version
rustc --version && cargo --version
java -version
gradle --version
ninja --version
code --version
opencode --version
ocr --version
openchamber --version
docker --version
docker compose version
```

### What's synced from the host

On first use (and on every later run) the runner wires three host
integrations into the sandbox:

- **Shared work directory** — `SANDBOX_WORK_DIR` / `--work-dir` mounts a
  host folder into the guest at `/mnt/hgfs/work`; see
  [Shared host folder](#shared-host-folder).
- **SSH agent + Docker engine bridges** — the host's SSH agent (a
  password manager) and Docker engine reach the guest (see
  [SSH agent bridge](#ssh-agent-bridge) and
  [Docker (remote engine)](#docker-remote-engine)).
- **User settings copy** — opencode/Copilot/VS Code/git configs and
  credentials are copied into the guest once per VM (see
  [User settings on the guest](#user-settings-on-the-guest)).

What is *not* synced: SSH keys (authentication goes through the bridged
agent), the macOS Keychain (extension auth), and VS Code extension state
— those stay on the host.

### OpenChamber from the host

[OpenChamber](https://openchamber.dev) is the web UI for OpenCode: start
sessions, supervise them, review changes — all from your host browser. The
image installs it as a systemd **user** service
(`agent-dev-env-openchamber`) that starts at boot (the image enables
`loginctl enable-linger admin`, so the user services run without anyone
logging in), listening on `0.0.0.0:4000`. The guest's IP is reachable
directly from the host, so with the VM running:

```bash
open "http://<guest-ip>:4000"
```

The default UI password is `sandbox`. Notes:

- Because the service starts at boot, no one has to log in — the desktop
  auto-logs the sandbox user in anyway (GDM3 `AutomaticLogin`), but
  OpenChamber does not depend on that.
- The UI binds to `0.0.0.0` inside the guest, which is only reachable over
  Fusion's NAT segment (vmnet8) — not your LAN (unless you bridge the guest
  network manually).
- `systemctl --user status agent-dev-env-openchamber` and
  `journalctl --user -u agent-dev-env-openchamber` (from the guest) help
  when something is off.

### Docker (remote engine)

The image ships the **Docker CLI** but no local engine: the engine is
bridged from the host instead, exactly like the macOS and Windows
sandboxes (a Linux guest *could* run containers, but the sandbox config
keeps engines out of the guest — the host engine is faster and has no
nested-virt surprises).

**The CLI wires the host's engine into the guest automatically.** When a
Docker engine socket is found on the host (Docker Desktop at
`~/.docker/run/docker.sock`, Colima, OrbStack, or `/var/run/docker.sock`),
it bridges it: a host-side forwarder (the bundled `bridge.js`, no socat)
exposes the socket on TCP `4401` (bound to the host's vmnet8 address —
reachable from the guest), and a guest-side systemd user service
(`agent-dev-env-docker`) presents it as the Unix socket `/tmp/docker.sock`.
`DOCKER_HOST` (and `TESTCONTAINERS_HOST_OVERRIDE` for clients that ignore
it) is exported for every shell — `/etc/profile.d/agent-dev-env.sh` for
login shells (when the agent runs as root) plus the sandbox user's
`~/.profile` and `~/.bashrc` (login shells and the interactive terminals
GNOME opens; a terminal never sources `~/.profile`, so `~/.bashrc` is what
makes the bridges visible there) — and the docker context `host` points at
the same socket, so `docker`, `docker compose`, and testcontainers all hit
the host engine:

```bash
# inside the guest — the CLI already set up the socket
docker context show          # host
docker run --rm hello-world
```

Notes:

- Containers run on the **host engine**, so published ports are bound on
  the host. From inside the guest they are reachable at the host's NAT
  address (the guest's default gateway — Fusion's NAT runs in userspace,
  so there is no vmnet8 interface on the host), *not* `localhost`.
- Volume mounts are resolved by the host daemon: bind-mount **host paths**
  in `docker run -v` and compose `volumes:` entries, not guest paths (the
  agent rules explain this; see
  [Sandbox agent rules](#sandbox-agent-rules)).
- The bridge survives guest reboots (systemd user services restart the
  relays) and the host side reconnects on the next run of the CLI. The
  host listener binds to the vmnet8 address only — the engine is not
  exposed to your LAN.
- The engine must be running when the CLI bridges it. If Docker Desktop
  isn't started yet, the bridge is skipped — start the engine and re-run
  the command (the setup is idempotent).
- Pass `--no-docker` to skip; `SANDBOX_DOCKER_PORT` overrides the bridge
  port (default `4401`; macOS `4101`, Windows QEMU `4201`, Windows VMware
  `4301`, so all four sandboxes can run side by side).

### SSH agent bridge

The CLI also bridges a password-manager SSH agent (Bitwarden, 1Password,
...) into the guest: a host-side forwarder (the bundled `bridge.js`, no
socat — see [the SSH agent guide](ssh-agent.md)) turns the agent socket
into TCP `4400` on the host's NAT address (the guest's default gateway),
and a guest-side systemd user service serves it as the Unix socket
`/tmp/ssh-agent.sock`. The guest's `SSH_AUTH_SOCK` environment variable
points at that socket, so `ssh`/`git` inside the guest authenticate with
the host's keys — no keys are copied into the guest.

Notes:

- Only an *overridden* agent is bridged (when `SSH_AUTH_SOCK` points at a
  password manager's socket). The stock macOS launchd agent is not bridged.
- The host listener lives only for the run (it stays up in background mode
  until killed); the guest side persists via the systemd user service.
- Pass `--no-agent` to skip; `SANDBOX_AGENT_PORT` overrides the bridge port
  (default `4400`; macOS `4100`, Windows QEMU `4200`, Windows VMware
  `4300`).

### Shared host folder

The image ships open-vm-tools (vmhgfs-fuse), so a host directory can be
shared into the guest (HGFS). Set it with `SANDBOX_WORK_DIR` (works for
every platform) or pass `--work-dir` on `run` (overrides the env var):

```bash
SANDBOX_WORK_DIR="$HOME/projects" npx agent-dev-env run ubuntu-vmware
npx agent-dev-env run ubuntu-vmware --work-dir "$HOME/projects"
```

The folder appears in the guest at `/mnt/hgfs/work` (mounted by the CLI on
each run). The run summary prints the mapping
(`Shared: /mnt/hgfs/work -> <host path>`) — or `Shared: not shared` when
nothing is shared. Notes:

- Best-effort: the CLI waits for VMware Tools to report running and
  retries the registration before giving up; when the share still could
  not be mounted (e.g. tools never came up), it warns and continues.
  Mount it manually in the guest:
  `sudo vmhgfs-fuse .host:/ /mnt/hgfs -o allow_other`.
- The share is read/write. Use git, or the OpenChamber UI as the
  alternative transport.

> [!TIP]
> To keep opencode's history and state between different sandboxes — the
> data directories are per-VM, so a deleted or cloned VM starts fresh —
> store them in the shared workdir:
>
> 1. Create directories for opencode and openchamber data in the shared
>    workdir (`/mnt/hgfs/work` is the guest side of the mount):
>
>    ```bash
>    mkdir -p /mnt/hgfs/work/data/opencode /mnt/hgfs/work/data/openchamber
>    ```
>
> 2. In the guest's `~/.profile` *and* `~/.bashrc` (login shells and the
>    interactive terminals GNOME opens; a terminal never sources
>    `~/.profile`, so `~/.bashrc` is what makes the vars visible there),
>    export the data directories and the opencode binary path — once per
>    new VM:
>
>    ```bash
>    # OpenChamber
>    export OPENCHAMBER_DATA_DIR="/mnt/hgfs/work/data/openchamber"
>    export OPENCODE_BINARY="$HOME/.opencode/bin/opencode"
>    export OPENCODE_DATA_DIR="/mnt/hgfs/work/data/opencode"
>    ```
>
>    The exports alone are not enough: OpenChamber runs as the systemd
>    user service `agent-dev-env-openchamber`, and systemd never reads
>    shell profiles — the image's unit pins its own environment. Add the
>    data directories with a drop-in override:
>
>    ```bash
>    systemctl --user edit agent-dev-env-openchamber
>    ```
>
>    then add (under `[Service]`):
>
>    ```ini
>    Environment=OPENCHAMBER_DATA_DIR=/mnt/hgfs/work/data/openchamber
>    Environment=OPENCODE_DATA_DIR=/mnt/hgfs/work/data/opencode
>    ```
>
>    and restart the service:
>
>    ```bash
>    systemctl --user restart agent-dev-env-openchamber
>    ```
>
>    The drop-in survives `agent-dev-env sync ubuntu-vmware` and runner
>    restarts (`systemctl` drop-ins are only read, never rewritten — the
>    `OPENCODE_BINARY` pin from the unit stays intact).

### User settings on the guest

On first run — and again whenever the settings change — `run` offers to
copy your host's user settings into the guest, so the agent works with your
credentials and preferences out of the box. What it copies (most files keep
their relative path; the two macOS-only locations are mapped to the Linux
XDG layout):

| Source (host) | Destination (guest) | Why |
| --- | --- | --- |
| `~/.config/opencode/opencode.json` (or `.jsonc`) | same path | OpenCode configuration (models, providers, permissions, MCP servers, npm plugins, agents/commands defined in JSON, ...) |
| `~/.config/opencode/tui.json` (or `.jsonc`) | same path | TUI preferences (theme, keybinds, notifications, ...) |
| `~/.config/opencode/agents/` | same path | Your custom OpenCode agents (markdown agent definitions) |
| `~/.config/opencode/commands/` | same path | Your custom OpenCode slash-commands |
| `~/.config/opencode/modes/` | same path | Custom focus modes |
| `~/.config/opencode/plugins/` | same path | Local OpenCode plugins (npm plugins come via `opencode.json` and auto-install) |
| `~/.config/opencode/skills/` | same path | Your global OpenCode skills (skill folders with `SKILL.md`) |
| `~/.config/opencode/tools/` | same path | Custom tool definitions |
| `~/.config/opencode/themes/` | same path | Custom UI themes |
| `~/.config/opencode/package.json` (+ lockfiles) | same path | Dependencies of local plugins — OpenCode runs `bun install` at startup |
| `~/.local/share/opencode/auth.json` | same path | OpenCode provider credentials — no `opencode auth login` needed in the guest |
| `~/.opencodereview/config.json` | same path | OpenCodeReview provider/model config (custom LLM endpoints, API keys) — `ocr` works in the guest as configured on the host |
| `~/.copilot/config.json` | same path | Copilot CLI settings (`~/.copilot` is where Copilot keeps its config) |
| `~/.copilot/skills/` | same path | Your Copilot skills (e.g. `gh/SKILL.md`), like the opencode ones |
| `~/.vscode/extensions/` | same path | Installed VS Code extensions — no reinstall in the guest |
| `~/Library/Application Support/Code/User/settings.json` | `~/.config/Code/User/settings.json` | VS Code settings, including per-extension settings (`github.copilot.*`, ...) |
| `~/Library/Application Support/Code/User/keybindings.json` | `~/.config/Code/User/keybindings.json` | Custom keyboard shortcuts |
| `~/Library/Application Support/Code/User/snippets/` | `~/.config/Code/User/snippets/` | User code snippets |
| `~/Library/Application Support/mcp-compress-router/` | `~/.local/share/mcp-compress-router/` | mcp-compress-router settings: the MCP server config (`mcp.json`) with its endpoints and credentials, plus the stored credentials and tool-schema cache. On Linux the router uses its XDG data dir (`~/.local/share/mcp-compress-router/`), not `~/.config/` |
| `~/.ssh/allowed_signers` | same path | SSH signing verification |
| `~/.ssh/known_hosts` | same path | SSH host keys you already trust |
| `~/.ssh/*.sh` | same path | SSH helper scripts (e.g. for signing) |
| `~/.gitconfig` | same path | Git identity, aliases, signing config |

The step runs **once per VM**: after copying, a versioned marker file inside
the guest (`~/.config/agent-dev-env/settings-copied`) records the settings
version that was copied, and later runs skip the step. When new settings are
added (and the settings version is bumped), the step runs again and copies
the additional files. Each time it runs it asks for confirmation and lists
what it will copy. To re-copy at any time, use `sync` below (it copies
regardless of the marker); to make `run` offer the copy again, delete the
marker in the guest first and re-run:

```bash
ssh admin@<guest-ip> rm ~/.config/agent-dev-env/settings-copied
npx agent-dev-env run ubuntu-vmware
```

To re-sync the settings **without** restarting the VM — e.g. after editing
`~/.config/opencode/opencode.json`, adding a skill or command, or updating
your Git identity — run `sync`:

```bash
npx agent-dev-env sync ubuntu-vmware
```

It copies exactly the same files as `run` (both share the same code), asks
for confirmation unless you pass `--yes`, and restarts OpenChamber so the
new settings take effect. The VM must be running — start it with
`npx agent-dev-env run ubuntu-vmware` first if it isn't. A sync also
updates the guest's version marker, so `run` won't re-offer the copy on
its next run.

Notes:

- Only files that exist on the host are copied.
- `.gitconfig` is adjusted for the guest (`admin`): paths under the host's
  home — including `program` values, which git execs verbatim — are
  rewritten to the guest's home (`/home/admin`).
- Skills and commands in a project's `.opencode/` directory are **not**
  copied — they come into the guest via the shared work directory; only the
  global `~/.config/opencode` ones are synced.
- npm plugins (the `plugin` key in `opencode.json`) are **not** copied —
  OpenCode installs them automatically at startup in the guest.
- After a copy, OpenChamber is restarted automatically so it picks up the new
  config and credentials.
- SSH **keys are not copied** — authentication goes through the bridged SSH
  agent.
- VS Code **extensions are copied** — no reinstall in the guest. Extension
  *auth* is a different story: it lives in the macOS **Keychain** and doesn't
  travel with the sync, so Copilot, GitHub, and similar will ask you to sign
  in once inside the guest.
- VS Code **extension state is not copied** — `globalStorage/`,
  `workspaceStorage/` and `History/` are host-local caches and stay behind;
  only `settings.json`, `keybindings.json` and `snippets/` travel.
- The guest's `~/.ssh/config` is not touched here — it is managed by the SSH
  agent bridge setup (`IdentityAgent`), see
  [SSH agent bridge](#ssh-agent-bridge).
- Pass `--no-settings` to skip the step for a run.

### Sandbox agent rules

On each run the CLI (after your confirmation) installs the sandbox
environment rules into the guest's coding agents — opencode's global
`~/.config/opencode/AGENTS.md` and the Copilot CLI's
`~/.copilot/copilot-instructions.md`. The content ships inside the npm
package (`assets/rules/agent-rules-linux.md`) and explains the runtime
topology: the shared-directory path mapping (host paths vs
`/mnt/hgfs/work`), the Docker remote-engine bridge (host paths in bind
mounts, published ports at the NAT gateway), and the SSH agent socket.
When a host-level global `~/.config/opencode/AGENTS.md` exists, it is
merged on top of the installed file: the host's global instructions come
first, then the sandbox rules behind a `---` separator. Files the user
edited are never overwritten without a separate confirmation.

### CLI reference

[`agent-dev-env run ubuntu-vmware`](cli.md) is the automated way to boot,
run, and wire up the sandbox. Everything it accepts — the full option list
and the environment variable table — is in [the CLI reference](cli.md);
notable defaults: image `sandbox-ubuntu-24-04-arm64-vmware`, agent bridge
port `4400`, Docker bridge port `4401`, `4` CPUs / 8 GB. A local image
archive can be pinned with `UBUNTU_VMWARE_IMAGE`; `FUSION_APP_PATH`
overrides the Fusion location.

## Building your own images

This repository is also a collection of image recipes. See
[DEVELOPMENT.md](../DEVELOPMENT.md) for how to build the Ubuntu image
locally (the ISO is bring-your-own) and publish it to GHCR.
