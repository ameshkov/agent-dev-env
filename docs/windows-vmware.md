# Set up a VMware Windows sandbox (Apple Silicon)

> **What you'll get.** A local sandbox virtual machine: a Windows 11 (ARM64)
> guest with a full coding toolchain and an AI coding agent (OpenCode)
> pre-installed, plus the OpenCodeReview code-review CLI and the OpenChamber
> web UI to run and supervise agent sessions from your host browser — running
> under VMware Fusion on your Apple Silicon Mac and reachable directly
> at its NAT IP (no port forwarding). Shared host folders are not
> supported for Windows 11 ARM guests on Apple silicon (see
> [Shared host folder](#shared-host-folder)).
>
> **Quick setup** — three steps and you're done:
>
> 1. [Install VMware Fusion](#1-install-vmware-fusion)
> 2. [Run the sandbox](#2-run-the-sandbox)
> 3. [Use the sandbox](#3-use-the-sandbox)
>
> Everything below the **Details** divider is optional reading: what's inside
> the image and how the pieces fit together.

## Which Windows sandbox?

This is the VMware (Fusion) variant. It exists alongside the
[QEMU-based Windows sandbox](windows-qemu.md):

| | VMware (this guide) | QEMU |
| --- | --- | --- |
| Hypervisor | VMware Fusion (free) | QEMU + HVF |
| Performance | Near-native | Near-native |
| Guest tools | VMware Tools (in-image) | virtio drivers |
| Shared host folder | No (not supported for Win11 ARM on Apple silicon) | No |
| Extra tools | Fusion only | qemu + swtpm |
| Publish artifact | vmx + vmdk (tar.gz) | qcow2 |

Both images install the same Windows 11 Pro ARM64 guest and toolchain; pick
either. Fusion is the better fit if you already use Fusion; QEMU needs no
extra VMware install.

## Quick setup

### Prerequisites

- An Apple Silicon Mac (M1 or newer). Fusion cannot virtualize ARM64 guests
  on Intel, so this sandbox is ARM64-only.
- [VMware Fusion](https://www.vmware.com/products/desktop-hypervisor/workstation-and-fusion)
  (free for personal use; the image is built against Fusion 13.6+).
- ~40 GB of free disk space (the image is ~20 GB, the working clone grows on
  top).

### Default account

Every sandbox guest has a single local user, used for SSH and RDP:

| User | Password |
| --- | --- |
| `Administrator` | `sandbox1` |

### 1. Install VMware Fusion

Download and install Fusion from the link above (free for personal use —
create a free Broadcom account if prompted). No license key is needed for
personal use. The runner talks to it through `vmrun`, which is inside the
app bundle — no `brew` step.

### 2. Run the sandbox

The [`agent-dev-env`](../docs/cli.md) CLI extracts the image, clones a
working VM, and wires up the bridges. Run it once without installing it:

```bash
npx agent-dev-env run windows-vmware
```

or install the CLI globally (`npm install -g agent-dev-env`) and use
`agent-dev-env run windows-vmware` everywhere below. On first use it picks
the image archive: the local build output
(`~/Library/Application Support/agent-dev-env/build/windows-vmware/...`)
when present, otherwise it asks to pull
`sandbox-windows-11-arm64-vmware:latest` from GHCR via
[oras](https://oras.land/) (one-time, ~20 GB — `brew install oras`). It
then extracts the pristine VM (once; the cache is shared across
instances) and clones a working VM per instance under
`~/Library/Application Support/agent-dev-env/windows-vmware/<image>/working/<instance>/`
(the clone's display name in Fusion's library is the instance name —
the base keeps the image's name) —
the pristine image is never written to. On the first clone the CLI
also upgrades the working VM's virtual hardware to the version your
Fusion supports (`vmrun upgradevm`, recorded once per clone) — without
it a newer Fusion shows its one-time "Upgrade this virtual machine?"
dialog on the first windowed start. The guest boots headless or in a
Fusion window (default), and the CLI discovers its NAT IP via VMware
Tools:

| Port | Guest service |
| --- | --- |
| 22 | SSH |
| 3389 | RDP |
| 4000 | OpenChamber web UI |
| 5985 | WinRM (advanced use) |

No port forwarding is needed: the VM sits on Fusion's NAT network
(vmnet8), and the host is that network's router, so the guest IP the CLI
prints is reachable directly from the host. When a Docker engine
is running on the host (Docker Desktop, Colima, OrbStack, ...), the
CLI bridges it into the guest; same for a password-manager SSH agent
(see [Docker (remote engine)](#docker-remote-engine) and
[SSH agent bridge](#ssh-agent-bridge)). On the very first run the CLI
also offers to enable Windows' auto-logon and reboot the guest once — the
image ships with auto-logon disabled after the OOBE boot, and the
OpenChamber web UI only starts at logon (see
[OpenChamber from the host](#openchamber-from-the-host)).

A Fusion window opens and the guest logs in automatically. Pass
`--foreground` to keep the terminal attached (Cmd+C stops the VM),
`--headless` to run without a window, `--no-agent` / `--no-docker` to
skip a bridge, or `--reset` to wipe the working VM and start fresh from
the pristine image.

> [!NOTE]
> The working VM is your sandbox: installs, config, and agent state
> accumulate in the clone and survive restarts. `--reset` deletes the
> clone — everything inside the guest is lost; the pristine image is not
> touched.

### 3. Use the sandbox

The CLI prints the guest IP (or find it anytime with
`vmrun -T fusion getGuestIPAddress <vmx>`). Everything is set up now —
use it from the host or inside the VM:

- **Browser UI (OpenChamber)**: open `http://<guest-ip>:4000/` on the host
  (default password: `sandbox`) and start or supervise agent sessions — see
  [OpenChamber from the host](#openchamber-from-the-host).
- **Desktop (RDP)**: connect to `<guest-ip>:3389` with Microsoft Remote
  Desktop (or any RDP client), user `Administrator` / `sandbox1`. The guest
  desktop has VS Code, Chrome, Firefox, and a Terminal.
- **Terminal (OpenCode)**: over SSH from the host:

  ```bash
  ssh Administrator@<guest-ip>
  ```

  Then configure the agent's LLM provider once (see
  [Configure the environment](#configure-the-environment)) and start it:

  ```powershell
  opencode
  ```

- **Code review (OpenCodeReview)**: the image ships the `ocr` CLI — see the
  [OpenCodeReview quick start](https://github.com/alibaba/open-code-review#quick-start).
- **Shared folder**: not supported for this guest (see
  [Shared host folder](#shared-host-folder)) — move files in and out with
  an SMB share, SSH/SCP, or the OpenChamber UI instead.

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
  npx agent-dev-env stop windows-vmware
  ```

  This stops the working VM (`vmrun -T fusion stop`, graceful via VMware
  Tools with a hard power-off fallback) and kills the host SSH agent /
  Docker bridge listeners. Start it again with
  `npx agent-dev-env run windows-vmware`.

- **Reset the sandbox** — wipe the working VM and start from the pristine
  image:

  ```bash
  npx agent-dev-env run windows-vmware --reset
  ```

- **Delete the sandbox** — remove the instance's state (the working
  clone; the shared pristine image cache goes with the last instance) and
  free the disk space:

  ```bash
  npx agent-dev-env delete windows-vmware --yes
  ```

  This stops the working VM first, then removes the instance's state dir
  under `~/Library/Application Support/agent-dev-env/windows-vmware/<image>/working/<instance>/`.
  The next run re-clones the instance. Other instances keep the shared
  pristine image. Without `--yes` it asks
  before deleting. Add `--pristine` to remove the shared pristine image
  cache too — also when an interrupted pull left no instance state behind
  (the cache is kept while another instance remains). Note: Fusion's VM
  library may still list the deleted
  working VM — remove the stale
  entry in the Fusion UI (harmless).

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
> npx agent-dev-env stop windows-vmware
> WORKDIR="$HOME/Library/Application Support/agent-dev-env/windows-vmware/sandbox-windows-11-arm64-vmware/working/default-agent-dev-env"
> ( cd "$WORKDIR" && tar -czf "$HOME/sandbox-windows-golden.tar.gz" *.vmx *.nvram *.vmdk )
> WINDOWS_VMWARE_IMAGE="$HOME/sandbox-windows-golden.tar.gz" \
>   npx agent-dev-env run windows-vmware --reset
> ```
>
> The archive must keep the layout the CLI extracts (the vmx and every
> disk it references next to it — the same layout `deploy` publishes), so
> pack the whole working directory. The `--reset` drops the current
> working clone first; the CLI then extracts your golden as the new
> pristine base and clones a fresh working VM from it — without `--reset`
> it asks whether to drop the working instances instead (default no).

---

## Details

### What's in the image

The image is built with [Packer](https://www.packer.io/)'s VMware plugin
(`vmware-iso`) from the official Windows 11 ARM64 ISO (bring-your-own, see
[images/windows-arm64-vmware/README.md](../images/windows-arm64-vmware/README.md))
and runs under Fusion via `vmrun`. It ships:

| Component | Detail |
| --- | --- |
| Windows 11 Pro (ARM64) | Unactivated (watermark); generic Pro key used for Setup |
| VMware Tools | ARM64 tools (from the Fusion install); enables guest IP discovery (no HGFS for Win11 ARM guests) |
| VMware drivers | vmxnet3 ARM64 NIC driver; NVMe disk uses the in-box driver |
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
| OpenCode (`opencode-ai`) | npm global |
| OpenCodeReview (`ocr`) | npm global (`@alibaba-group/open-code-review`) |
| OpenChamber web UI | npm global (`@openchamber/web`), scheduled task on `0.0.0.0:4000` |
| OpenChamber desktop app | win-arm64 NSIS installer, hash-pinned; Start Menu shortcut |
| Long paths + Developer Mode | Registry (`LongPathsEnabled`, `AllowDevelopmentWithoutDevLicense`) + `git config --system core.longpaths` |
| OpenSSH Server + RDP | Enabled; Administrator/sandbox1 (see the vars file) |
| Image identity | `%USERPROFILE%\.config\agent-dev-env\image.json` (image name + `image_version`, baked at build time) |
| Docker CLI | Client only (`docker` + `docker compose`), remote engine via the host bridge |
| Bridge tooling | Node.js (in-image) relays for the SSH-agent/Docker bridges (the host side is the CLI's own forwarder — no socat) |

Verify the toolchain over SSH (`ssh Administrator@<guest-ip>`, password
`sandbox1`):

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
user settings copy (the shared work directory stays macOS/Ubuntu-only):

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

Not synced: there is **no shared host folder** for Windows 11 ARM guests —
`--work-dir` is accepted but skipped with a warning (see
[Shared host folder](#shared-host-folder)).

### User settings on the guest

On first run — and again whenever the settings change — `run` offers to
copy your host's user settings into the guest, so the agent works with your
credentials and preferences out of the box. What it copies (most files
keep their path under `%USERPROFILE%`; the two macOS-only locations are
mapped to the Windows layout):

| Source (host) | Destination (guest) | Why |
| --- | --- | --- |
| `~/.config/opencode/opencode.json` (or `.jsonc`) | same path | OpenCode configuration (models, providers, permissions, MCP servers, npm plugins, agents/commands defined in JSON, ...) |
| `~/.config/opencode/tui.json` (or `.jsonc`) | same path | TUI preferences (theme, keybinds, notifications, ...) |
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
ssh Administrator@<guest-ip>
del "%USERPROFILE%\.config\agent-dev-env\settings-copied"
```

To re-sync the settings on the running VM — e.g. after editing
`%USERPROFILE%\.config\opencode\opencode.json`, adding a skill or command,
or updating your Git identity — run `sync`:

```bash
agent-dev-env sync windows-vmware
```

It copies exactly the same files as `run` (both share the same code), asks
for confirmation unless you pass `--yes`, and restarts OpenChamber (the
`dev.openchamber.web` scheduled task) so the new settings take effect.
When it also wrote the host's `OPENCODE_MODELS_URL`, it offers the guest
reboot the new environment variable needs (default: yes; `--yes` accepts
it) — see [User settings on the guest](#user-settings-on-the-guest). The
VM must be running — start it with `agent-dev-env run windows-vmware`
first if it isn't. A sync also updates the guest's version marker, so
`run` won't re-offer the copy on its next run.

Notes:

- Only files that exist on the host are copied.
- `.gitconfig` is adjusted for the guest: host home paths are rewritten
  to `%USERPROFILE%` (forward slashes). Private SSH keys stay on the host
  — the SSH agent bridge provides them inside the guest.

### OpenChamber from the host

[OpenChamber](https://openchamber.dev) is the web UI for OpenCode: start
sessions, supervise them, review changes — all from your host browser. The
image installs it as a scheduled task (`dev.openchamber.web`) that starts at
**logon**, listening on `0.0.0.0:4000`. The guest's IP is reachable directly
from the host, so with the VM running:

```bash
open "http://<guest-ip>:4000"
```

The default UI password is `sandbox`. Notes:

- Because the task fires at logon, the guest must be logged in. The CLI
  enables Windows' auto-logon on first use (with your confirmation) so the
  guest logs itself in at boot and the UI comes up without interaction. The
  image's `autounattend.xml` deliberately sets `LogonCount=1` — one OOBE
  auto-login only — which is why the runner re-enables it.
- The UI binds to `0.0.0.0` inside the guest, which is only reachable over
  Fusion's NAT segment (vmnet8) — not your LAN (unless you bridge the guest
  network manually).
- `openchamber status` and `openchamber logs` (from the guest) help when
  something is off.
- The "up" line in the run summary is a **boot-time probe**: the server
  can later stop answering (the TCP listener may stay up while HTTP never
  responds — `openchamber status` then reports "no running instance"
  while the port still accepts). If the UI hangs, restart the server:
  `agent-dev-env sync windows-vmware` re-copies the user settings and
  restarts OpenChamber through its `dev.openchamber.web` task, or from
  the guest (RDP/SSH): `schtasks /End /TN dev.openchamber.web` then
  `schtasks /Run /TN dev.openchamber.web`.

### Docker (remote engine)

The image ships the **Docker CLI** but no local engine: a Windows guest
cannot run a hypervisor (no nested virtualization through Fusion), so
Docker Desktop / WSL2 inside the sandbox would fail their hypervisor
checks — the same constraint as the macOS guest. The CLI works as-is
against any remote engine.

**The CLI wires the host's engine into the guest automatically.** When a
Docker engine socket is found on the host (Docker Desktop at
`~/.docker/run/docker.sock`, Colima, OrbStack, or `/var/run/docker.sock`),
it bridges it: a host-side forwarder (the bundled `bridge.js`, no socat)
exposes the socket on TCP `4301` (bound to the host's vmnet8 address —
reachable from the guest), and a guest-side Node relay (served by the
image's `node.exe`) presents it as the `\\.\pipe\docker_engine` named
pipe — the exact pipe Docker on Windows looks for by default. A docker
context named `host` is created and made the default, so `docker`,
`docker compose`, and docker clients that read the default pipe all hit
the host engine:

```powershell
# inside the guest — the CLI already set up the context
docker context show          # host
docker run --rm hello-world
```

Notes:

- Containers run on the **host engine**, so published ports are bound on
  the host. From inside the guest they are reachable at the host's NAT
  address (the guest's default gateway — Fusion's NAT runs in userspace,
  so there is no vmnet8 interface on the host), *not* `localhost`.
- The bridge survives guest reboots (an ONLOGON scheduled task restarts the
  relays at logon) and the host side reconnects on the next run of the CLI.
  The host listener binds to the vmnet8 address only — the engine is not
  exposed to your LAN.
- The engine must be running when the CLI bridges it. If Docker Desktop
  isn't started yet, the bridge is skipped — start the engine and re-run
  the command (the setup is idempotent).
- Pass `--no-docker` to skip; `SANDBOX_DOCKER_PORT` overrides the bridge
  port (default `4301`; QEMU uses `4201`, macOS `4101`, Ubuntu `4401`, so
  all four sandboxes can run side by side).
- Container-based test frameworks (testcontainers and similar) work out of
  the box: on Windows they dial the default named pipe, which *is* the
  bridged engine.

### SSH agent bridge

The CLI also bridges a password-manager SSH agent (Bitwarden, 1Password,
...) into the guest: a host-side forwarder (the bundled `bridge.js`, no
socat — see [the SSH agent guide](ssh-agent.md)) turns the agent socket
into TCP `4300` on the host's NAT address (the guest's default gateway),
and a guest-side Node relay serves it as the
`\\.\pipe\openssh-ssh-agent` named pipe. The guest's `SSH_AUTH_SOCK`
environment variable points at that pipe, so `ssh`/`git` inside the guest
authenticate with the host's keys — no keys are copied into the guest.

Notes:

- Only an *overridden* agent is bridged (when `SSH_AUTH_SOCK` points at a
  password manager's socket). The stock macOS launchd agent is not bridged.
- The host listener lives only for the run (it stays up in background mode
  until killed); the guest side persists via the ONLOGON task.
- Pass `--no-agent` to skip; `SANDBOX_AGENT_PORT` overrides the bridge port
  (default `4300`; QEMU uses `4200`, macOS `4100`, Ubuntu `4400`).

### Shared host folder

Not supported. VMware Fusion does not support shared folders (HGFS) for
Windows 11 ARM guests on Apple silicon — VMware Tools for Windows Arm
ships no HGFS driver, so the guest can never mount
`\\vmware-host\Shared Folders\work` even though the host publishes the
share. See VMware's
[guest OS support matrix](https://techdocs.broadcom.com/us/en/vmware-cis/desktop-hypervisors/fusion-pro/13-0/using-vmware-fusion/sharing-files-between-windows-and-your-mac/guest-operating-systems-that-support-shared-folders.html)
("Shared Folder is not supported for Windows 11 ARM GOS on Apple Silicon
hosts") and
[KB 315602](https://knowledge.broadcom.com/external/article/315602).

`SANDBOX_WORK_DIR` and `--work-dir` are still accepted for consistency
with the other platforms, but the CLI detects the unsupported combo and
skips the share with a warning — it no longer claims the folder is
shared. Alternatives that do work:

- **SMB from the Mac**: enable File Sharing for a folder in macOS
  (System Settings → General → Sharing → File Sharing), then from the
  guest map `\\172.16.26.1\<share>` and authenticate with your Mac
  login/password — the host is the NAT router on vmnet8
  (`172.16.26.1`).
- **SSH/SCP**: the guest runs OpenSSH — use `scp` from the host or
  `ssh Administrator@<guest-ip>` to copy files in and out.
- **RDP clipboard, git push/pull, or the OpenChamber UI** (upload/
  download), the same alternative transports as the QEMU sandbox.

### CLI reference

[`agent-dev-env run windows-vmware`](cli.md) is the automated way to
boot, run, and wire up the sandbox. Everything it accepts — the full
option list and the environment variable table — is in
[the CLI reference](cli.md); notable defaults: image
`sandbox-windows-11-arm64-vmware`, agent bridge port `4300`, Docker bridge
port `4301`, `4` CPUs / 8 GB. A local archive can be pinned with
`WINDOWS_VMWARE_IMAGE`; `FUSION_APP_PATH` overrides the Fusion location.
`--work-dir` / `SANDBOX_WORK_DIR` are accepted but skipped with a warning
(see [Shared host folder](#shared-host-folder)).

## Building your own images

This repository is also a collection of image recipes. See
[DEVELOPMENT.md](../DEVELOPMENT.md) for how to build the Windows image
locally (the ISO is bring-your-own) and publish it to GHCR.
