# Set up a Windows sandbox (Apple Silicon)

> **Prefer VMware?** This guide is the QEMU-based sandbox. A VMware
> (Fusion) variant with the same guest and toolchain — plus a shared host
> folder — exists too: [Set up a Windows VMware sandbox](windows-vmware.md).
>
> **What you'll get.** A local sandbox virtual machine: a Windows 11 (ARM64)
> guest with a full coding toolchain and an AI coding agent (OpenCode)
> pre-installed, plus the OpenCodeReview code-review CLI and the OpenChamber
> web UI to run and supervise agent sessions from your host browser — running
> under QEMU on your Apple Silicon Mac. Your code stays on your host; the
> sandbox reaches it through git, the RDP clipboard, or the OpenChamber UI
> (there is no shared host directory — see
> [No shared folder](#no-shared-folder)).
>
> **Quick setup** — three steps and you're done:
>
> 1. [Install QEMU and swtpm](#1-install-qemu-and-swtpm)
> 2. [Run the sandbox](#2-run-the-sandbox)
> 3. [Use the sandbox](#3-use-the-sandbox)
>
> Everything below the **Details** divider is optional reading: what's inside
> the image and how the pieces fit together.

## Quick setup

### Prerequisites

- An Apple Silicon Mac (M1 or newer). Windows on ARM under QEMU requires
  HVF, and HVF can only virtualize ARM64 guests — this sandbox is ARM64-only.
- [QEMU](https://www.qemu.org/) and [swtpm](https://github.com/stefanberger/swtpm)
  (the virtual TPM 2.0 — Windows 11 requires one).
- ~40 GB of free disk space (the image is ~25 GB, the working VM grows on
  top).

### Default account

Every sandbox guest has a single local user, used for SSH and RDP:

| User | Password |
| --- | --- |
| `Administrator` | `sandbox1` |

### 1. Install QEMU and swtpm

```bash
brew install qemu swtpm
```

No socat is needed anymore — the SSH agent and Docker bridges use the
CLI's own forwarder (see [the CLI reference](cli.md) and
[the SSH agent guide](ssh-agent.md)).

### 2. Run the sandbox

The [`agent-dev-env`](../docs/cli.md) CLI boots the image, forwards the
guest ports, and wires up the bridges. Run it once without installing it:

```bash
npx agent-dev-env run windows-qemu
```

or install the CLI globally (`npm install -g agent-dev-env`) and use
`agent-dev-env run windows-qemu` everywhere below. On first use it picks
the disk image: the local build output
(`~/Library/Application Support/agent-dev-env/build/windows-qemu/...`)
when present, otherwise it asks to pull
`sandbox-windows-11-arm64-qemu:latest` from GHCR via
[oras](https://oras.land/) (one-time, ~25 GB — `brew install oras`). The
image arrives in 512 MiB chunks fetched one by one; an interrupted pull
keeps what it already downloaded, and the working disk is assembled from
the chunks (they are removed once it is complete). It then creates a
working VM per instance — a copy-on-write overlay plus
persistent TPM and EFI state under
`~/Library/Application Support/agent-dev-env/windows-qemu/<image>/working/<instance>/` —
the pristine image is never written to. The guest boots headless or in a QEMU
window (default), and SSH/RDP/OpenChamber ports are forwarded to the host:

| Port | Guest service |
| --- | --- |
| 2222 | SSH |
| 3389 | RDP |
| 4000 | OpenChamber web UI |
| 5985 | WinRM (advanced use) |

When a Docker engine is running on the host (Docker Desktop, Colima,
OrbStack, ...), the CLI bridges it into the guest; same for a
password-manager SSH agent (see
[Docker (remote engine)](#docker-remote-engine) and
[SSH agent bridge](#ssh-agent-bridge)). On the very first run the CLI
also offers to enable Windows' auto-logon and reboot the guest once — the
image ships with auto-logon disabled after the OOBE boot, and the
OpenChamber web UI only starts at logon (see
[OpenChamber from the host](#openchamber-from-the-host)).

A window opens and the guest logs in automatically. Pass `--foreground` to
keep the terminal attached (Cmd+C stops the VM), `--headless` to run
without a window, `--no-agent` / `--no-docker` to skip a bridge, or
`--reset` to wipe the working VM and start fresh from the pristine image.

> [!NOTE]
> The QEMU window drives the guest resolution directly: the runtime VM
> uses a virtio-gpu-pci display and the image ships the virtio-gpu driver
> (viogpudo), so drag the window edges to resize and Windows changes its
> display resolution to match (no scaling). The QEMU window's **View**
> menu still offers **Enter Fullscreen** (Cmd+F) for native macOS full
> screen and **Zoom To Fit** to toggle the guest-scaling mode.
>
> The working VM is your sandbox: installs, config, and agent state
> accumulate in the COW overlay and survive restarts (like a Tart clone on
> the macOS side). `--reset` deletes the overlay, the TPM state, and the EFI
> NVRAM — everything inside the guest is lost; the pristine image is not
> touched.

### 3. Use the sandbox

Everything is set up now — use it from the host or inside the VM:

- **Browser UI (OpenChamber)**: open `http://127.0.0.1:4000/` on the host
  (default password: `sandbox`) and start or supervise agent sessions — see
  [OpenChamber from the host](#openchamber-from-the-host).
- **Desktop (RDP)**: connect to `127.0.0.1:3389` with Microsoft Remote
  Desktop (or any RDP client), user `Administrator` / `sandbox1`. The guest
  desktop has VS Code, Chrome, Firefox, and a Terminal.
- **Terminal (OpenCode)**: over SSH from the host:

  ```bash
  ssh -p 2222 Administrator@127.0.0.1
  ```

  Then configure the agent's LLM provider once (see
  [Configure the environment](#configure-the-environment)) and start it:

  ```powershell
  opencode
  ```

- **Code review (OpenCodeReview)**: the image ships the `ocr` CLI — see the
  [OpenCodeReview quick start](https://github.com/alibaba/open-code-review#quick-start).

### Configure the environment

The coding agent (OpenCode) needs an LLM provider before it can work. Over
SSH or in the guest's PowerShell, add yours:

```powershell
opencode providers login
```

This walks you through the provider setup (API key, model, ...). Once
configured, restart OpenChamber so it picks up the provider:

```powershell
openchamber restart
```

### Everyday commands

- **Stop the sandbox** — from the host:

  ```bash
  npx agent-dev-env stop windows-qemu
  ```

  This stops qemu (via the `qemu.pid` the CLI writes), swtpm and the host
  SSH agent / Docker bridge listeners. The manual fallback is:

  ```bash
  kill $(cat "$HOME/Library/Application Support/agent-dev-env/windows-qemu/sandbox-windows-11-arm64-qemu/working/qemu.pid")
  ```

  (or `pkill -f qemu-system-aarch64`). Start it again with
  `npx agent-dev-env run windows-qemu`.

- **Reset the sandbox** — wipe the working VM and start from the pristine
  image:

  ```bash
  npx agent-dev-env run windows-qemu --reset
  ```

- **Delete the sandbox** — remove the instance's state (the working disk
  overlay, the TPM and EFI NVRAM; the shared pristine qcow2 cache goes
  with the last instance) and free the disk space:

  ```bash
  npx agent-dev-env delete windows-qemu --yes
  ```

  This stops qemu + swtpm first, then removes the instance's state dir
  under `~/Library/Application Support/agent-dev-env/windows-qemu/<image>/working/<instance>/`.
  The next run re-clones the instance. Other instances keep the shared
  pristine image. Without `--yes` it asks
  before deleting. Add `--pristine` to remove the shared pristine qcow2
  cache too — also when an interrupted pull left no instance state behind
  (the cache is kept while another instance remains: its working disk is
  a COW overlay backed by the pristine qcow2).

- **Run several sandboxes side by side** — set a distinct `SANDBOX_VM`
  per sandbox (instances share the pristine image) and free ports:
  `SANDBOX_SSH_PORT` / `SANDBOX_RDP_PORT` / `SANDBOX_OPENCHAMBER_PORT` /
  `SANDBOX_AGENT_PORT` / `SANDBOX_DOCKER_PORT`.

> [!TIP]
> Once a sandbox is configured the way you like it (installed tools,
> provider login, VS Code extensions — everything the working overlay
> accumulated), promote it to a *golden image* of your own instead of
> carrying that setup over by hand:
>
> ```bash
> npx agent-dev-env stop windows-qemu
> OVERLAY="$HOME/Library/Application Support/agent-dev-env/windows-qemu/sandbox-windows-11-arm64-qemu/working/default-agent-dev-env/sandbox-windows-11-arm64-qemu.qcow2"
> qemu-img convert -O qcow2 "$OVERLAY" "$HOME/sandbox-windows-golden.qcow2"
> WINDOWS_IMAGE="$HOME/sandbox-windows-golden.qcow2" \
>   npx agent-dev-env run windows-qemu --reset
> ```
>
> The converted disk is standalone (no backing image), so it works as the
> pristine image; the CLI still creates a fresh COW overlay, TPM state and
> EFI NVRAM per instance. Pass `--reset` (or accept the "backing image
> changed" prompt) so the new working VM is created from the golden disk
> instead of the old one.

---

## Details

### What's in the image

The image is built with [Packer](https://www.packer.io/)'s QEMU plugin from
the official Windows 11 ARM64 ISO (bring-your-own, see
[images/windows-arm64-qemu/README.md](../images/windows-arm64-qemu/README.md))
and runs under `qemu-system-aarch64` with HVF. It ships:

| Component | Detail |
| --- | --- |
| Windows 11 Pro (ARM64) | Unactivated (watermark); generic Pro key used for Setup |
| VirtIO drivers | viostor/vioscsi, NetKVM, vioserial, balloon + qemu guest agent |
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
| Rust | Via rustup (arm64 host toolchain + MSVC targets), `rust`/`cargo` on PATH |
| JDK (Temurin) | Official Adoptium win-aarch64 zip machine `JAVA_HOME` + `bin` on PATH, verified `jni.h`/`jvm.lib` (JDK, not a JRE) |
| Conan | C/C++ dependency manager, current release via pip |
| VS2022 Build Tools | Choco + `setup.exe` finalizer: .NET 4.8/.NET Core SDKs, VC++ workload (x86/x64/ARM/ARM64), ATL, CMake, Windows 11 SDK |
| WiX, protoc, NASM, LLVM | Choco packages (versions from the vars file) |
| Visual Studio Code | Native arm64 build, latest stable, direct download; `code` on PATH |
| Google Chrome | Official Windows ARM64 enterprise MSI (live channel — no version or hash pin); native arm64 |
| Firefox | Choco package (x64, runs under emulation) |
| OpenCode (`@opencode/cli`, V2) | npm global |
| OpenCodeReview (`ocr`) | npm global (`@alibaba-group/open-code-review`) |
| OpenChamber web UI | 2.x (`@openchamber/web`), scheduled task on `0.0.0.0:4000` |
| OpenChamber desktop app | 2.0.0 (win-arm64 NSIS installer, hash-pinned); Start Menu shortcut |
| Long paths + Developer Mode | Registry (`LongPathsEnabled`, `AllowDevelopmentWithoutDevLicense`) + `git config --system core.longpaths` |
| OpenSSH Server + RDP | Enabled; Administrator/sandbox1 (see the vars file) |
| Image identity | `%USERPROFILE%\.config\agent-dev-env\image.json` (image name + `image_version`, baked at build time) |
| Docker CLI | Client only (`docker` + `docker compose`), remote engine via the host bridge |
| Bridge tooling | Node.js (in-image) relays for the SSH-agent/Docker bridges (the host side is the CLI's own forwarder — no socat) |

Verify the toolchain over SSH (`ssh -p 2222 Administrator@127.0.0.1`,
password `sandbox1`):

```powershell
node --version && npm --version
pnpm --version && yarn --version
python --version
git --version
git lfs version
gh --version
rg --version
jq --version
go version
rustc --version && cargo --version
java -version
conan --version
ninja --version
protoc --version
code --version
opencode --version
ocr --version
openchamber --version
docker --version
docker compose version
```

### What's synced from the host

The Windows guests run the same bridges as the other sandboxes, plus the
user settings copy (the shared host directory stays macOS/Ubuntu-only):

- **SSH agent bridge** — a password-manager SSH agent (Bitwarden,
  1Password, ...) is bridged into the guest; `ssh`/`git` inside the
  sandbox authenticate with the host's keys, no key leaves the host (see
  [SSH agent bridge](#ssh-agent-bridge)).
- **Docker engine bridge** — the host's Docker engine is bridged into the
  guest, so the image's Docker CLI works as-is (see
  [Docker (remote engine)](#docker-remote-engine)).
- **User settings copy** — your host's opencode config and credentials,
  OpenCodeReview config, Copilot config, VS Code settings/extensions,
  `~/.ssh` helpers and `.gitconfig` are copied into the guest on first run
  (and again when the settings change), so the agent works with your
  config and credentials out of the box — see
  [User settings on the guest](#user-settings-on-the-guest).

Not synced: there is **no shared host directory** — the virtio-fs driver
has no ARM64 Windows build (see [No shared folder](#no-shared-folder)).

### User settings on the guest

On first run — and again whenever the settings change — `run` offers to
copy your host's user settings into the guest, so the agent works with your
credentials and preferences out of the box. What it copies (most files
keep their path under `%USERPROFILE%`; the two macOS-only locations are
mapped to the Windows layout):

| Source (host) | Destination (guest) | Why |
| --- | --- | --- |
| `~/.agents/` | same path | Cross-agent personal settings: the shared skills (`~/.agents/skills/`) and their install lockfile, read by OpenCode, Copilot and Codex |
| `~/.config/opencode/opencode.json` (or `.jsonc`) | same path | OpenCode configuration (models, providers, permissions, MCP servers, npm plugins, agents/commands defined in JSON, ...) |
| `~/.config/opencode/cli.json` (V2) or `tui.json` (V1, or `.jsonc`) | same path | Terminal preferences (theme, keybinds, notifications, ...) |
| `~/.config/opencode/agents/` through `themes/`, `package.json` (+ lockfiles) | same path | Your custom OpenCode agents, commands, modes, plugins, skills, tools, themes and local-plugin deps |
| `~/.local/share/opencode/auth.json` | same path | OpenCode provider credentials — no `opencode auth login` needed in the guest (opencode keeps `~/.local/share/opencode` on Windows too) |
| `~/.opencodereview/config.json` | same path | OpenCodeReview provider/model config — `ocr` works in the guest as configured on the host |
| `~/.copilot/config.json` and `~/.copilot/skills/` | same path | Copilot CLI settings and your Copilot skills |
| `~/.vscode/extensions/` | same path | Installed VS Code extensions — no reinstall in the guest |
| `~/Library/Application Support/Code/User/settings.json` | `%APPDATA%\Code\User\settings.json` | VS Code settings, including per-extension settings (`github.copilot.*`, ...) |
| `~/Library/Application Support/Code/User/keybindings.json` | `%APPDATA%\Code\User\keybindings.json` | Custom keyboard shortcuts |
| `~/Library/Application Support/Code/User/snippets/` | `%APPDATA%\Code\User\snippets\` | User code snippets |
| `~/Library/Application Support/mcp-compress-router/` | `%APPDATA%\mcp-compress-router\` | mcp-compress-router settings: the MCP server config (`mcp.json`) with its endpoints and credentials — on Windows the router reads it from `%APPDATA%`, not `~/.config` |
| `~/.ssh/allowed_signers`, `~/.ssh/known_hosts`, `~/.ssh/*.sh` | same path | SSH signing verification, trusted host keys and SSH helper scripts |
| `~/.gitconfig` | same path | Git identity, aliases, signing config (paths rewritten to `%USERPROFILE%`) |

The copy also carries the host's `OPENCODE_MODELS_URL` when it is set:
opencode resolves model IDs against a model registry (fetched from
`${OPENCODE_MODELS_URL}/api.json`, the models.dev format) — a custom
registry is what makes a private provider's models (e.g. `tokenguard/*`)
resolve in the guest. The copy sets it for the user and appends it to
OpenChamber's `startup.env`. Windows applies a user environment variable
only to processes started afterwards, so the copy then offers a guest
reboot (default: yes) — the reboot makes sure OpenChamber and opencode
see the variable. `--yes` accepts the offer without a prompt.

The step runs **once per VM**: after copying, a versioned marker file
inside the guest (`%USERPROFILE%\.config\agent-dev-env\settings-copied`)
records the settings version that was copied, and later runs skip the
step. When new settings are added (and the settings version is bumped),
the step runs again and copies the additional files. Each time it runs it
asks for confirmation and lists what it will copy. To re-copy at any time,
use `sync` below (it copies regardless of the marker); to make `run` offer
the copy again, delete the marker in the guest first and re-run:

```bash
ssh -p 2222 Administrator@127.0.0.1
del "%USERPROFILE%\.config\agent-dev-env\settings-copied"
```

To re-sync the settings on the running VM — e.g. after editing
`%USERPROFILE%\.config\opencode\opencode.json`, adding a skill or command,
or updating your Git identity — run `sync`:

```powershell
agent-dev-env sync windows-qemu
```

It copies exactly the same files as `run` (both share the same code), asks
for confirmation unless you pass `--yes`, and restarts OpenChamber (the
`dev.openchamber.web` scheduled task) so the new settings take effect.
When it also wrote the host's `OPENCODE_MODELS_URL`, it offers the guest
reboot the new environment variable needs (default: yes; `--yes` accepts
it) — see [User settings on the guest](#user-settings-on-the-guest). The
VM must be running — start it with `agent-dev-env run windows-qemu` first
if it isn't. A sync also updates the guest's version marker, so `run`
won't re-offer the copy on its next run.

Notes:

- Only files that exist on the host are copied.
- `.gitconfig` is adjusted for the guest: host home paths are rewritten
  to `%USERPROFILE%` (forward slashes). Private SSH keys stay on the host
  — the SSH agent bridge provides them inside the guest.

### OpenChamber from the host

[OpenChamber](https://openchamber.dev) is the web UI for OpenCode: start
sessions, supervise them, review changes — all from your host browser. The
image installs it as a scheduled task (`dev.openchamber.web`) that starts at
**logon**, listening on `0.0.0.0:4000`; the CLI forwards it to the host, so
with the VM running:

```bash
open "http://127.0.0.1:4000"
```

The default UI password is `sandbox`. Notes:

- Because the task fires at logon, the guest must be logged in. The CLI
  enables Windows' auto-logon on first use (with your confirmation) so the
  guest logs itself in at boot and the UI comes up without interaction. The
  image's `autounattend.xml` deliberately sets `LogonCount=1` — one OOBE
  auto-login only — which is why the runner re-enables it.
- The UI binds to `0.0.0.0` inside the guest, but QEMU's user-mode network
  only forwards the host ports — nothing is exposed to your LAN.
- `openchamber status` and `openchamber logs` (from the guest) help when
  something is off.
- The "up" line in the run summary is a **boot-time probe**: the server
  can later stop answering (the TCP listener may stay up while HTTP never
  responds — `openchamber status` then reports "no running instance"
  while the port still accepts). If the UI hangs, restart the server:
  `agent-dev-env sync windows-qemu` re-copies the user settings and
  restarts OpenChamber through its `dev.openchamber.web` task, or from
  the guest (RDP/SSH): `schtasks /End /TN dev.openchamber.web` then
  `schtasks /Run /TN dev.openchamber.web`.

### Docker (remote engine)

The image ships the **Docker CLI** but no local engine: a Windows guest
cannot run a hypervisor (no nested virtualization through HVF), so Docker
Desktop / WSL2 inside the sandbox would fail their hypervisor checks — the
same constraint as the macOS guest. The CLI works as-is against any remote
engine.

**The CLI wires the host's engine into the guest automatically.** When a
Docker engine socket is found on the host (Docker Desktop at
`~/.docker/run/docker.sock`, Colima, OrbStack, or `/var/run/docker.sock`),
it bridges it: a host-side forwarder (the bundled `bridge.js`, no socat)
exposes the socket on TCP `4201` (loopback only), and a guest-side Node
relay (served by the image's `node.exe`) presents it as the
`\\.\pipe\docker_engine` named pipe — the exact pipe Docker on Windows
looks for by default. A docker context named `host` is created and made the
default, so `docker`, `docker compose`, and docker clients that read the
default pipe all hit the host engine:

```powershell
# inside the guest — the CLI already set up the context
docker context show          # host
docker run --rm hello-world
```

Notes:

- Containers run on the **host engine**, so published ports are bound on
  the host. From inside the guest they are reachable at `10.0.2.2` (QEMU's
  host alias), *not* `localhost`:
  `docker run -d -p 8080:80 nginx` then, in the guest,
  `curl http://10.0.2.2:8080`. From the host itself the port is
  `http://localhost:8080` as usual.
- The bridge survives guest reboots (an ONLOGON scheduled task restarts the
  relays at logon) and the host side reconnects on the next run of the CLI.
  The host listener binds to the loopback interface only — the engine is
  not exposed to your LAN.
- The engine must be running when the CLI bridges it. If Docker Desktop
  isn't started yet, the bridge is skipped — start the engine and re-run
  the command (the setup is idempotent).
- Pass `--no-docker` to skip; `SANDBOX_DOCKER_PORT` overrides the bridge
  port (default `4201`; VMware uses `4301`, macOS `4101`, so all three
  sandboxes can run side by side).
- Container-based test frameworks (testcontainers and similar) work out of
  the box: on Windows they dial the default named pipe, which *is* the
  bridged engine.

### SSH agent bridge

The CLI also bridges a password-manager SSH agent (Bitwarden, 1Password,
...) into the guest: a host-side forwarder (the bundled `bridge.js`, no
socat — see [the SSH agent guide](ssh-agent.md)) turns the agent socket
into TCP `4200` (loopback only), and a guest-side Node relay serves it as
the `\\.\pipe\openssh-ssh-agent` named pipe. The guest's `SSH_AUTH_SOCK`
environment variable points at that pipe, so `ssh`/`git` inside the guest
authenticate with the host's keys — no keys are copied into the guest.

Notes:

- Only an *overridden* agent is bridged (when `SSH_AUTH_SOCK` points at a
  password manager's socket). The stock macOS launchd agent is not bridged.
- The host listener lives only for the run (it stays up in background mode
  until killed); the guest side persists via the ONLOGON task.
- Pass `--no-agent` to skip; `SANDBOX_AGENT_PORT` overrides the bridge port
  (default `4200`; VMware uses `4300`, macOS `4100`).

### No shared folder

There is no host-directory mount like the macOS image's shared `dev`
volume: the QEMU stack cannot deliver one on this host/guest pair. Two
independent gaps close both sides of the only real mechanism (virtio-fs):

- **Guest side — no ARM64 virtio-fs driver.** QEMU's native shared-folder
  device is virtio-fs, and Windows needs the `viofs` driver from
  `virtio-win` to mount it. That driver is built only for x86/x86_64 —
  there is no ARM64 build for Windows 11 ARM64 guests (virtio-win issue
  #1337). The ARM64 driver set this image stages (viostor / vioscsi /
  NetKVM) covers storage and networking only, not filesystems.
- **Host side — `virtiofsd` is Linux-only.** The virtio-fs device is served
  by `virtiofsd`, a FUSE-based userspace daemon with no macOS build; even
  with an ARM64 driver a mount could not be served from an Apple Silicon
  host.

The other QEMU sharing options don't fit either: the legacy 9p device has
no Windows driver at all, and QEMU's `smb=` user-mode helper needs an
`smbd` running on the host and is Linux-oriented. So this sandbox keeps the
host-directory-is-remote model: your code stays on the host and travels by
network transport instead. The macOS and VMware sandboxes *do* have
workspace mounts, but only because their hypervisors provide the pieces —
Apple's Virtualization.framework on macOS and HGFS under Fusion, both with
matching in-guest drivers for those native guests.

Your code stays on the host; get it into the sandbox with:

- **git** — clone/push from inside the guest (the bridged SSH agent covers
  authentication).
- **RDP clipboard** — copy files and text between host and guest.
- **The OpenChamber web UI** — attach a host directory to a session, or use
  the workspace picker.

### CLI reference

[`agent-dev-env run windows-qemu`](cli.md) is the automated way to boot,
run, and wire up the sandbox. Everything it accepts — the full option list
and the environment variable table — is in [the CLI reference](cli.md);
notable defaults: image `sandbox-windows-11-arm64-qemu`, SSH/RDP/WinRM
host forwards `2222`/`3389`/`5985`, agent bridge port `4200`, Docker bridge
port `4201`, `4` CPUs / 8 GB. A local disk image can be pinned with
`WINDOWS_IMAGE`.

## Building your own images

This repository is also a collection of image recipes. See
[DEVELOPMENT.md](../DEVELOPMENT.md) for how to build the Windows image
locally (the ISO is bring-your-own) and publish it to GHCR.
