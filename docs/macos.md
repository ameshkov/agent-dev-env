# Set up a macOS sandbox (Apple Silicon)

> **What you'll get.** A local sandbox virtual machine: a macOS guest with a
> full coding toolchain and an AI coding agent (OpenCode) pre-installed, plus
> the OpenCodeReview code-review CLI, the OpenChamber web UI to run and
> supervise agent sessions from your host browser and the OpenChamber desktop
> app inside the guest, running on your Apple Silicon Mac. Your code stays on
> your host —
> you share a working directory into the VM and run the agent on it from
> inside the sandbox.
>
> **Quick setup** — four steps and you're done:
>
> 1. [Install Tart](#1-install-tart)
> 2. [Run the sandbox](#2-run-the-sandbox)
> 3. [Configure the environment](#3-configure-the-environment)
> 4. [Use the sandbox](#4-use-the-sandbox)
>
> Everything below the **Details** divider is optional reading: what's inside
> the image and how to configure the VM.

## Quick setup

### Prerequisites

- An Apple Silicon Mac (M1 or newer). macOS guests cannot run on Intel Macs.
- macOS 13 (Ventura) or newer on the host.
- ~150 GB of free disk space (the image is large).

### Default account

Every sandbox VM has a single local user. The image auto-logs in as this user
on boot, and the same credentials are used for SSH and Screen Sharing:

| User | Password |
| --- | --- |
| `admin` | `admin` |

### 1. Install Tart

[Tart](https://tart.run/) is the virtual machine manager this sandbox runs on.
It is built on Apple's Virtualization framework. Install it with Homebrew:

```bash
brew install cirruslabs/cli/tart
```

### 2. Run the sandbox

The [`agent-dev-env`](../docs/cli.md) CLI replaces the manual pull, clone,
configure, and run steps. Run it once without installing it:

```bash
npx agent-dev-env run macos
```

or install the CLI globally (`npm install -g agent-dev-env`) and use
`agent-dev-env run macos` everywhere below. Share a specific workspace
instead of the default `/Volumes/dev`:

```bash
npx agent-dev-env run macos --work-dir /path/to/your/workspace
```

On first use it asks before pulling the image (~77 GB, one-time) and cloning
a working VM, then starts it in the background with the recommended settings
(8 CPUs / 16 GB) and your work directory shared. When detected, it also
bridges your SSH agent (see [docs/ssh-agent.md](ssh-agent.md)) and Docker
engine (see [Docker (remote engine)](#docker-remote-engine)) into the guest,
and copies your user settings in once per VM (see
[User settings on the guest](#user-settings-on-the-guest)).

A window opens and auto-logs in as `admin` (`admin`); clipboard sharing
works. Every run restarts the Tart guest agent on boot, so the vdagent
clipboard link is re-established even when it went stale across previous
VM stop/start cycles. Pass `--foreground` to keep the terminal attached
(Cmd+C stops the VM), `--headless` to run without a window, `--no-agent`
to skip the SSH agent bridge, `--no-docker` to skip the Docker bridge, or
`--no-settings` to skip the settings copy.

> [!NOTE]
> While the VM window is focused, system shortcuts — Cmd+Space (Spotlight),
> Cmd+Tab (app switcher), ... — go to the guest, not the host (on by default
> for windowed runs). One exception: switching input sources (^+Space by
> default) may stay on the host — macOS intercepts it at the system level,
> below the VM window. To switch input sources inside the guest, bind it to
> a combination that is unbound on the host (System Settings → Keyboard →
> Keyboard Shortcuts → Input Sources, e.g. Cmd+Option+Space).
>
> [!TIP]
> For a sharp, full-window resolution in fullscreen, first set the guest
> display to its default: **System Settings → Displays → Advanced…** →
> **Default for display**.

This follows the recommended **one VM, many projects** workflow: keep **one**
sandbox VM and share your whole working directory into it, so your code stays
on the host while the toolchain and agent live in the VM and are reused across
all projects (see [The one-VM, many-projects workflow in depth](#the-one-vm-many-projects-workflow-in-depth)).
By default the CLI shares `/Volumes/dev` — the host directory with all your
projects — into the guest at `/Volumes/My Shared Files/dev`.

Two environment variables cover most needs (the full list is in the
[CLI reference](cli.md)):

| Variable | Default | What it does |
| --- | --- | --- |
| `SANDBOX_WORK_DIR` | `/Volumes/dev` | Host directory shared into the guest; empty disables the mount |
| `SANDBOX_VM` | `default-agent-dev-env` | Sandbox instance name — also the Tart working VM name; set it to run several sandboxes side by side |

For example, a separate sandbox for one project:

```bash
SANDBOX_VM=my-project SANDBOX_WORK_DIR="$HOME/dev/my-project" npx agent-dev-env run macos
```

### 3. Configure the environment

If you already have opencode configured on this Mac, you're likely done:
`agent-dev-env run macos` syncs your local settings (config, provider
credentials, skills, ...) into the guest, so the agent is ready to work right
away. Only configure it here if you haven't used opencode on the host, or
want a different provider in the sandbox.

The coding agent (OpenCode) needs an LLM provider before it can work. In the
VM's Terminal, add yours:

```bash
opencode providers login
```

(In a headless VM, run it over SSH or with `tart exec -t <vm-name> opencode
providers login`.)

This walks you through the provider setup (API key, model, ...). Once
configured, restart OpenChamber so it picks up the provider:

```bash
openchamber restart
```

### 4. Use the sandbox

Everything is set up now — use it from the host or inside the VM:

- **Browser UI (OpenChamber)**: on the host, open `http://<sandbox-ip>:4000/`
  (the IP is `tart ip <vm-name>`; default password: `sandbox`) and start or
  supervise agent sessions from your browser — see
  [OpenChamber from the host](#openchamber-from-the-host). You can also use
  your local OpenChamber macOS app and connect it to the sandboxed instance.
- **Desktop app (OpenChamber)**: inside the VM's desktop, launch
  **OpenChamber** from Launchpad — the native macOS app (see
  [OpenChamber desktop app](#openchamber-desktop-app)).
- **Terminal (OpenCode)**: in the VM's Terminal, open the shared work
  directory and start the agent:

```bash
cd "/Volumes/My Shared Files/dev"
opencode
```

- **Code review (OpenCodeReview)**: the image ships the `ocr` CLI, pre-
  configured with your host's LLM settings (synced via
  `~/.opencodereview/config.json`) — see the
  [OpenCodeReview quick start](https://github.com/alibaba/open-code-review#quick-start)
  for usage.

All your host projects are inside — `cd` into whichever folder you're working
on and the agent sees your code. That's it — you are running an AI coding agent
in an isolated sandbox, with your code safely on the host.

### Everyday commands

- **Force-sync your host settings into the sandbox** — opencode config and
  auth, OpenCodeReview config, Copilot config and skills, VS Code config and
  extensions, mcp-compress-router, `~/.ssh` and `~/.gitconfig` (the same set
  as on first run). The VM must be running:

  ```bash
  npx agent-dev-env sync macos --yes
  ```

  The sync command always copies everything (unlike `run`, which only
  offers the copy when the settings version changed), so this is the command
  to re-sync after editing a config on the host. `--yes` skips the
  confirmation prompt. It restarts OpenChamber so the new settings take
  effect, and updates the guest's settings marker — see
  [User settings on the guest](#user-settings-on-the-guest) for details.

- **Stop the sandbox** — graceful shutdown of the guest, up to 30 seconds:

  ```bash
  npx agent-dev-env stop macos
  ```

  This stops the working VM (`tart stop`, graceful with a force fallback)
  and the host SSH agent / Docker bridge listeners the runner left up — a
  bare `tart stop` would leave the bridge listeners running.
  `default-agent-dev-env` is the default instance name (the Tart working
  VM name; override with
  `SANDBOX_VM`; `stop` honors the same `SANDBOX_AGENT_PORT` /
  `SANDBOX_DOCKER_PORT` overrides). If the
  guest hangs, `tart stop` force-terminates it after a timeout; `stop`
  passes none, so wait longer manually with
  `tart stop <vm> --timeout <seconds>`. Start it again with
  `npx agent-dev-env run macos`.

- **Delete the sandbox** — remove the VM(s) from the Tart VM store, disk
  included:

  ```bash
  npx agent-dev-env delete macos --yes
  ```

  This stops the sandbox first, then `tart delete`s the working VM — the
  next run re-clones it from the pristine image. Without `--pristine`, the
  pristine image (~77 GB, re-pulled from GHCR on the next run) is kept when
  deleting interactively — press `y` at the prompt or pass `--pristine` /
  `--yes` to delete it too. Options are the same `SANDBOX_VM` /
  `SANDBOX_IMAGE` overrides as `run`.

> [!TIP]
> Once a sandbox is configured the way you like it (installed tools,
> provider login, VS Code extensions — everything the working VM
> accumulated), promote it to a *golden image* of your own instead of
> carrying that setup over by hand:
>
> ```bash
> tart stop default-agent-dev-env
> tart clone default-agent-dev-env my-sandbox-golden
> ```
>
> The clone is a regular Tart VM. Use it as the runner's pristine image:
>
> ```bash
> SANDBOX_IMAGE=my-sandbox-golden agent-dev-env run macos
> ```
>
> The runner clones the working VM from it and never pulls GHCR when the
> image VM is present. Keep the golden VM stopped — the runner refuses to
> clone a running image — and re-promote it any time the working VM gains
> useful state (`tart clone` again over the old golden). To share it with
> other machines, `tart push my-sandbox-golden <repo>` once.

---

## Details

### What's in the image

The images are built with [Packer](https://www.packer.io/) + the
[Tart Packer plugin](https://github.com/cirruslabs/packer-plugin-tart) and run
with Tart. The default image ships the following software:

| Software | Version (default image) |
| --- | --- |
| macOS | 26 (Tahoe) |
| Xcode | 26.5 (+ Command Line Tools) |
| Homebrew | latest |
| Node.js + npm | 26 (via nvm; npm globals: `pnpm`, `yarn`) |
| nvm | latest (Node.js version manager) |
| Python | 3.14 (`python`, `python3`, `pip`, `pip3` aliases) |
| Ruby | latest (brew; `rbenv` for project-pinned interpreters) |
| Go | latest (brew) |
| Rust | pinned toolchain (rustup; aarch64/x86_64 macOS + iOS targets) |
| Java | 17.0.11-oracle (SDKMAN; `JAVA_HOME` exported) |
| Flutter | 3.38.3 (base image checkout at `$FLUTTER_HOME`, precached) |
| Gradle | 8.7 (wrapper distribution pre-cached in `~/.gradle`) |
| Kotlin/Native | 1.9.24 (pre-cached in `~/.konan`) |
| Android SDK | base image (platform-tools, platforms;android-36, build-tools;36.0.0, NDK 28.2, licenses accepted) + `ndk;29.0.14206865` and `build-tools;34.0.0` pre-installed |
| CMake / Ninja | latest (brew) |
| Swift tooling | `xcodegen`, `swiftlint`, `periphery` (brew) |
| Visual Studio Code | latest (+ `code` CLI) |
| Sublime Text | latest (stable, + `subl` CLI) |
| Google Chrome | latest (universal) |
| Firefox | latest (universal) |
| OpenCode | V2 (Homebrew tap formula `opencode-v2`) |
| OpenCodeReview | latest (AI code review CLI, `ocr`, config synced from the host) |
| OpenChamber | 2.x (web UI for OpenCode V2, auto-started on port 4000) |
| OpenChamber desktop app | 2.x (native macOS app, `/Applications/OpenChamber.app`) |
| Docker CLI | latest (`docker` + `docker compose` / `docker buildx` plugins; client only — no local engine, see [Docker (remote engine)](#docker-remote-engine)) |
| CLI tools | `git` + `git-lfs`, `gh`, `jq`, `ripgrep`, `coreutils`, `curl`, `wget`, `socat`, `bash` |
| Global git config | git-lfs filters, legacy `ssh-rsa` key types, CocoaPods specs repo blocked (`insteadOf`) |
| Image identity | `~/.config/agent-dev-env/image.json` (image name + `image_version`, baked at build time) |

Verify the toolchain from the guest Terminal (or over SSH:
`ssh admin@$(tart ip <vm-name>)`, password `admin`):

```bash
xcodebuild -version
brew --version
node --version && npm --version
pnpm --version && yarn --version
nvm --version
python3 --version
ruby --version
rbenv --version
go version
rustc --version && cargo --version
java -version
flutter --version
gradle --version
cmake --version
ninja --version
xcodegen --version
swiftlint --version
periphery version
git lfs version
code --version
subl --version
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
"/Applications/Firefox.app/Contents/MacOS/firefox" --version
opencode --version
ocr --version
openchamber --version
defaults read "/Applications/OpenChamber.app/Contents/Info.plist" CFBundleShortVersionString
docker --version
docker compose version
docker buildx version
```

### What's synced from the host

On first use (and on every later run) the runner wires three host
integrations into the sandbox:

- **Shared work directory** — a host directory is mounted into the guest
  at `/Volumes/My Shared Files/<mount-name>` (default `dev`); see
  [The one-VM, many-projects workflow in depth](#the-one-vm-many-projects-workflow-in-depth).
- **SSH agent + Docker engine bridges** — the host's SSH agent (a
  password manager) and Docker engine reach the guest (see
  [Docker (remote engine)](#docker-remote-engine) and
  [docs/ssh-agent.md](ssh-agent.md)).
- **User settings copy** — opencode/Copilot/VS Code/git configs and
  credentials are copied into the guest once per VM (see
  [User settings on the guest](#user-settings-on-the-guest)).

What is *not* synced: SSH keys (authentication goes through the bridged
agent), the macOS Keychain (extension auth), and VS Code extension state
— those stay on the host.

### OpenChamber from the host

[OpenChamber](https://openchamber.dev) is the web UI for OpenCode: start
sessions, supervise them, review changes — all from your host browser. It is
installed in the image and starts automatically at login (LaunchAgent
`dev.openchamber.web`), listening on `0.0.0.0:4000` inside the VM. With the VM
running, open it from the host:

```bash
open "http://$(tart ip <vm-name>):4000"
```

The default UI password is `sandbox` — the same convention as the `admin`
account. To change it, run inside the guest:

```bash
openchamber startup disable
OPENCODE_BINARY="$(command -v opencode)" openchamber startup enable --port 4000 --lan --ui-password 'your-password'
```

(`startup enable` snapshots the current environment into the LaunchAgent, so
keep the `OPENCODE_BINARY` pin from the image when re-enabling the service.)

Notes:

- The VM sits behind Tart's NAT network, so in practice only the host can
  reach the UI — still, don't set an easy password if your host is on a shared
  network.
- The service runs the installed `opencode` CLI under the hood; the image
  bakes the resolved binary path (`OPENCODE_BINARY`) into the LaunchAgent, so
  the service doesn't depend on the login session's `PATH`. `openchamber
  status` (state of the server) and `openchamber logs` (recent output) from
  the guest help when something is off.
- Headless (`tart run --no-graphics`) works too — auto-login still brings up
  the session that hosts the LaunchAgent.

### OpenChamber desktop app

The image also ships the native OpenChamber macOS app
(`/Applications/OpenChamber.app`, installed via the `openchamber` Homebrew
cask). It is the day-to-day UI for working inside the guest desktop: launch
**OpenChamber** from Launchpad (or `open -a OpenChamber` in the guest
Terminal). Like the web UI, it runs on top of OpenCode — the app bundles its
own OpenCode CLI and, by default, manages its own server, so its sessions are
separate from the web UI service above.

To make the desktop app share the sandbox's server (same sessions as the
browser UI and the host), pair it with the service on port 4000:

```bash
# inside the guest
openchamber connect-url --port 4000 --server http://127.0.0.1:4000 --name sandbox
```

Then, in the app, import the printed link under **Settings → Remote
Instances → Other OpenChamber servers → Import Link**. The app reconnects on
its own after restarts.

Notes:

- The app checks for updates against GitHub releases and offers them in-app —
  nothing installs without your say-so.
- The desktop app targets the guest desktop, so it is of limited use in a
  headless VM — the web UI remains the remote-friendly surface (see above).

### Docker (remote engine)

The image ships the **Docker CLI** (`docker`, via Homebrew) with the `docker
compose` and `docker buildx` plugins already wired into the CLI config — but
no local engine. A container engine on macOS is itself a Linux VM, and macOS
guests cannot nest VMs: Apple's Virtualization.framework supports nested
virtualization only for **Linux** guests (M3+ chips, macOS 15+), so Docker
Desktop, Colima and similar fail their hypervisor check inside the sandbox.
The CLI works as-is against any remote engine.

**The CLI wires the host's engine into the guest automatically.**
`agent-dev-env run macos` looks for a Docker engine socket on the host
(Docker Desktop at `~/.docker/run/docker.sock`, Colima, OrbStack, or
`/var/run/docker.sock`); when it finds one, it bridges it into the guest the
same way as the SSH agent: a host-side forwarder (the bundled `bridge.js`,
no socat) for the current run, and a guest-side one (installed by the macOS
guest agent as a LaunchAgent, recreated on every login) that serves the
socket at `~/.docker/run/docker.sock`. A docker context named `host` is
created in the guest and made the default, so `docker`, `docker compose`,
`docker buildx` — from a terminal or from the coding agent — all hit the
host engine. The guest's `~/.zprofile` also exports `DOCKER_HOST` (the
bridged socket) and `TESTCONTAINERS_HOST_OVERRIDE` (the NAT gateway), so
docker clients that don't read contexts — e.g. the testcontainers library —
find the engine and its published ports too (see the note below):

```bash
# inside the guest — the runner already set up the context
docker context show          # host
docker run --rm hello-world
```

Notes:

- Containers run on the **host engine**, so published ports are bound on the
  host, not in the guest. From inside the guest they are reachable at the
  NAT gateway — `192.168.64.1`, *not* `localhost`:
  `docker run -d -p 8080:80 nginx` then `curl http://192.168.64.1:8080`.
  From the host itself, the same port is `http://localhost:8080` as usual.
  Verify the gateway with `route -n get default` inside the guest.
- Container-based test frameworks (testcontainers and similar) work in the
  guest out of the box: the guest agent's `~/.zprofile` exports make them
  dial the host engine and its published ports via the NAT gateway. Without
  `TESTCONTAINERS_HOST_OVERRIDE` they assume the engine is local and try
  `localhost`, where nothing is published — this shows up as
  `Failed to connect to Reaper` (the testcontainers cleanup container
  itself starts fine on the host engine). One caveat: task runners that
  filter the environment — turbo passes through only a built-in set plus
  declared variables — need the vars declared too, e.g. on the `test`
  task in `turbo.json`: `"env": ["DOCKER_HOST",
  "TESTCONTAINERS_HOST_OVERRIDE"]`.
- The host engine must be running when the runner bridges it (the socket only
  exists then). If Docker Desktop isn't started yet, the runner skips the
  bridge — start the engine and re-run `agent-dev-env run` (or just run it
  again; the setup is idempotent).
- The bridge is per-boot: the host-side listener lives for the current run
  (in background mode it stays up until killed, see the runner's summary),
  and the guest side recreates its socket at every login. If the guest is
  rebooted while the host listener is still up, docker keeps working; after a
  host reboot, re-run `agent-dev-env run`.
- Pass `--no-docker` to skip the bridge. `SANDBOX_DOCKER_PORT` overrides the
  bridge port (default `4101`).
- The listener binds only to the VM network gateway address, so it is not
  exposed to your LAN — same trust model as the SSH agent bridge: the sandbox
  can use your host's Docker engine (and, via the agent bridge, your SSH
  keys).

**Manual setup** — when you'd rather point the CLI at an engine the runner
doesn't detect, e.g. the host's Docker Desktop over SSH instead of a socket
(the bridged SSH agent covers authentication, see
[docs/ssh-agent.md](ssh-agent.md)):

```bash
# inside the guest — use the host's Docker engine over SSH
docker context create host --docker "host=ssh://<host-user>@<host-ip>"
docker context use host
docker run --rm hello-world
```

- `<host-user>` is your macOS host user name; `<host-ip>` is the VM's NAT
  gateway — usually `192.168.64.1` (check with `route -n get default` in the
  guest).
- The host must run Docker Desktop with Remote Login (SSH) enabled, and your
  SSH key must be authorized on the host (`~/.ssh/authorized_keys`) — the
  bridged agent presents it.
- Any other remote engine works the same way: `docker context create <name>
  --docker "host=ssh://user@host"` or `--docker
  "host=tcp://<host>:2376"` (TLS-protected).
- No engine is needed for image inspection: `docker manifest inspect alpine`
  works offline.

The agents inside the guest know all of this out of the box: the runner
installs a rules file for them on every run (opencode global `AGENTS.md` +
Copilot CLI instructions), see
[Agent rules in the guest](#agent-rules-in-the-guest).

### The one-VM, many-projects workflow in depth

A sandbox VM accumulates useful state (installed tools, agent config, shell
history) — treat that as a feature: keep **one** sandbox VM and mount every
project into it.

Notes:

- Share your whole work volume once (`--dir=dev:/Volumes/dev`) or repeat
  `--dir` per project — in both cases the mount has to be passed on every
  `tart run`. Save the command as a shell alias or a small script of your
  own.
- If a project genuinely needs isolation (e.g. an incompatible toolchain),
  clone an extra VM for it — `tart clone sandbox project-a-isolated` — no
  rebuild needed.
- If the sandbox gets messy: `tart stop sandbox && tart delete sandbox`, then
  re-clone from the pristine image. All your code stays safe on the host.

> [!TIP]
> To keep opencode's history and state between different sandboxes — the
> data directories are per-VM, so a deleted or cloned VM starts fresh —
> store them in the shared workdir:
>
> 1. Create directories for opencode and openchamber data in your shared
>    workdir:
>
>    ```bash
>    mkdir -p /Volumes/dev/data/opencode /Volumes/dev/data/openchamber
>    ```
>
>    (`/Volumes/dev` is the host side of the default mount; use the host path
>    of your own `--work-dir`.)
>
> 2. In the guest's `~/.zprofile`, export the data directories (and the
>    opencode binary path) — once per new VM:
>
>    ```bash
>    # OpenChamber
>    export OPENCHAMBER_DATA_DIR="/Volumes/My Shared Files/dev/data/openchamber"
>    export OPENCODE_BINARY="/opt/homebrew/bin/opencode"
>    export OPENCODE_DATA_DIR="/Volumes/My Shared Files/dev/data/opencode"
>    ```
>
>    The exports alone are not enough: OpenChamber runs as the launchd
>    service `dev.openchamber.web`, and launchd never reads shell
>    profiles. `openchamber startup enable` snapshots the environment
>    into the service's LaunchAgent — the runner re-snapshots it
>    (sourcing `~/.zprofile` first) whenever it restarts OpenChamber
>    after a settings copy and on `agent-dev-env sync macos`. To
>    re-snapshot by hand:
>
>    ```bash
>    openchamber startup disable
>    openchamber startup enable --port 4000 --lan --ui-password 'sandbox'
>    ```
>
>    (keep the `--ui-password` — this is also the change-password pattern
>    from [OpenChamber from the host](#openchamber-from-the-host); pass
>    the same port as `SANDBOX_OPENCHAMBER_PORT` when you override it.)

### User settings on the guest

On first run — and again whenever the settings change — the runner offers to
copy your host's user settings into the guest, so the agent works with your
credentials and preferences out of the box. What it copies:

| Source (host) | Destination (guest) | Why |
| --- | --- | --- |
| `~/.agents/` | same path | Cross-agent personal settings: the shared skills (`~/.agents/skills/`) and their install lockfile, read by OpenCode, Copilot and Codex |
| `~/.config/opencode/opencode.json` (or `.jsonc`) | same path | OpenCode configuration (models, providers, permissions, MCP servers, npm plugins, agents/commands defined in JSON, ...) |
| `~/.config/opencode/cli.json` (V2) or `tui.json` (V1, or `.jsonc`) | same path | Terminal preferences (theme, keybinds, notifications, ...) |
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
| `~/Library/Application Support/Code/User/settings.json` | same path | VS Code settings, including per-extension settings (`github.copilot.*`, ...) |
| `~/Library/Application Support/Code/User/keybindings.json` | same path | Custom keyboard shortcuts |
| `~/Library/Application Support/Code/User/snippets/` | same path | User code snippets |
| `~/Library/Application Support/mcp-compress-router/` | same path | mcp-compress-router settings: the MCP server config (`mcp.json`) with its endpoints and credentials, plus the stored credentials and tool-schema cache |
| `~/.ssh/allowed_signers` | same path | SSH signing verification |
| `~/.ssh/known_hosts` | same path | SSH host keys you already trust |
| `~/.ssh/*.sh` | same path | SSH helper scripts (e.g. for signing) |
| `~/.gitconfig` | same path | Git identity, aliases, signing config |

The copy also carries the host's `OPENCODE_MODELS_URL` when it is set:
opencode resolves model IDs against a model registry (fetched from
`${OPENCODE_MODELS_URL}/api.json`, the models.dev format) — a custom
registry is what makes a private provider's models (e.g. `tokenguard/*`)
resolve in the guest. The copy writes the value to
`~/.config/agent-dev-env/models-url.env` and sources it from
`~/.zprofile`/`~/.zshrc`; the OpenChamber restart that follows the copy
sources `~/.zprofile` before re-creating the LaunchAgent, so the variable
lands in the service environment. No guest reboot is needed.

The step runs **once per VM**: after copying, a versioned marker file inside
the guest (`~/.config/agent-dev-env/settings-copied`) records the settings
version that was copied, and later runs skip the step. When new settings are
added (and the settings version is bumped), the step runs again and copies
the additional files. Each time it runs it asks for confirmation and lists
what it will copy. To force a re-copy, delete the marker and re-run:

```bash
tart exec sandbox rm ~/.config/agent-dev-env/settings-copied
npx agent-dev-env run macos
```

To re-sync the settings **without** restarting the VM — e.g. after editing
`~/.config/opencode/opencode.json`, adding a skill or command, or updating
your Git identity — run `sync`:

```bash
npx agent-dev-env sync macos
```

It copies exactly the same files as `run` (both share the same code),
applies the host's `OPENCODE_MODELS_URL` (see above), asks for
confirmation unless you pass `--yes`, and restarts OpenChamber so the
new settings take effect. The VM must be running — start it with
`npx agent-dev-env run macos` first if it isn't. A sync also updates the
guest's version marker, so `run` won't re-offer the copy on its next run.
Like the runner, sync honors `SANDBOX_VM` (default
`default-agent-dev-env`) — use it to sync a non-default sandbox:

```bash
SANDBOX_VM=my-project npx agent-dev-env sync macos --yes
```

Notes:

- Only files that exist on the host are copied.
- `.gitconfig` is adjusted for the guest (`admin`): paths under the host's
  home — including `program` values, which git execs verbatim — are
  rewritten to the guest's home (`/Users/admin`).
- Skills and commands in a project's `.opencode/` directory are **not**
  copied — they come into the guest via the shared work directory; only the
  global `~/.config/opencode` and `~/.agents` ones are synced.
- npm plugins (the `plugin` key in `opencode.json`) are **not** copied —
  OpenCode installs them automatically at startup in the guest.
- After a copy, OpenChamber is restarted automatically so it picks up the new
  config and credentials.
- SSH **keys are not copied** — authentication goes through the bridged SSH
  agent (see [docs/ssh-agent.md](ssh-agent.md)).
- VS Code **extensions are copied** — no reinstall in the guest. Extension
  *auth* is a different story: it lives in the macOS **Keychain** and doesn't
  travel with the sync, so Copilot, GitHub, and similar will ask you to sign
  in once inside the guest.
- VS Code **extension state is not copied** — `globalStorage/`,
  `workspaceStorage/` and `History/` are host-local caches and stay behind;
  only `settings.json`, `keybindings.json` and `snippets/` travel.
- The guest's `~/.ssh/config` is not touched here — it is managed by the SSH
  agent bridge setup (`IdentityAgent`), see [docs/ssh-agent.md](ssh-agent.md).
- Pass `--no-settings` to skip the step for a run.

### Agent rules in the guest

On every run, the runner also installs a short sandbox environment rules
file into the guest's coding agents — opencode's global rules
(`~/.config/opencode/AGENTS.md`) and the Copilot CLI's personal instructions
(`~/.copilot/copilot-instructions.md`) — so both agents understand the
runtime topology without being told. The rules explain the Docker remote
engine (context `host`, published ports reachable at the NAT gateway instead
of `localhost`, volume mounts needing host paths), the shared-directory path
mapping and the SSH agent bridge. The content ships inside the npm package
(`assets/rules/agent-rules.md`).

When you have a host-level global `~/.config/opencode/AGENTS.md`, it is
merged on top of the installed file: the host's global instructions come
first, then the sandbox rules behind a `---` separator. The guest copy is
therefore *host global AGENTS.md + sandbox rules* (the only exception is
when you edited the guest's copy yourself — the runner asks instead of
overwriting it).

Notes:

- The rules are refreshed on every run, but the runner always asks before
  installing or updating them. When you modified the guest's copy yourself,
  the prompt asks whether to overwrite it and defaults to no.
- The shared-directory paths in the rules are substituted from the actual
  run settings (`SANDBOX_WORK_DIR`, `SANDBOX_MOUNT_NAME`), and the SSH agent
  section is included only when the agent bridge is actually up — the rules
  never claim a bridge that isn't running.
- The rules are not part of the user-settings copy. An updated rules file
  (from a newer CLI version) is offered on the next run; the runner asks
  before replacing the guest's copy.

### CLI reference

[`agent-dev-env run macos`](cli.md) is the automated way to pull, run, and
wire up the sandbox. Everything it accepts — the full option list and the
environment variable table — is in [the CLI reference](cli.md); the
defaults: image `sandbox-macos-tahoe`, instance `default-agent-dev-env`
(the Tart working VM name), agent bridge port `4100`, Docker bridge port
`4101`, 8 CPUs / 16 GB. Logs land in
`~/Library/Logs/agent-dev-env/tart-<vm>.log`.

## Building your own images

This repository is also a collection of image recipes. See
[DEVELOPMENT.md](../DEVELOPMENT.md) for how to build images locally, add new
images (macOS versions), and publish them to GHCR.
