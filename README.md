# agent-dev-env

[![CI](https://github.com/ameshkov/agent-dev-env/actions/workflows/ci.yml/badge.svg)](https://github.com/ameshkov/agent-dev-env/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-dev-env)](https://www.npmjs.com/package/agent-dev-env)
[![GitHub release](https://img.shields.io/github/v/release/ameshkov/agent-dev-env)](https://github.com/ameshkov/agent-dev-env/releases)

Local sandbox virtual machines for AI coding agents. A pre-built image with
the full toolchain (macOS with Xcode/Homebrew, Windows 11 ARM64 with
VS2022/toolchains, or Ubuntu 24.04 with the open-source toolchain; OpenCode,
OpenCodeReview, OpenChamber, Docker CLI bridged to the host) runs on your
Mac. Your code stays on the host — you share a working directory into the VM
and let a coding agent work on it in an isolated sandbox. The
[`agent-dev-env`](https://www.npmjs.com/package/agent-dev-env) CLI builds,
runs, and wires up the sandboxes, and manages their image releases.

**Currently supported:** macOS host on Apple Silicon → macOS (Tart),
Windows 11 ARM64 (QEMU, VMware Fusion) and Ubuntu 24.04 LTS ARM64 (VMware
Fusion) guests. Linux hosts are coming soon.

## Quick start

Try it without installing:

```bash
npx agent-dev-env doctor            # host + tooling check for every platform
npx agent-dev-env run macos         # pull, boot, and wire up the macOS sandbox
```

Or install the CLI globally:

```bash
npm install -g agent-dev-env
agent-dev-env run macos
```

Want the latest build from the `master` branch? The CI publishes a canary
build on every push to npm under the `canary` dist-tag:

```bash
npm install -g agent-dev-env@canary
```

On first use the CLI asks before pulling the image (one-time, ~77 GB for
macOS) and creating the working VM, then starts it with the recommended
settings. Every guest gets the host's SSH agent and Docker engine bridged
in; the macOS and Ubuntu guests additionally share your work directory and
copy your user settings in. What works where differs per guest — see the
[macOS guide](docs/macos.md), [Ubuntu guide](docs/ubuntu-vmware.md),
[Windows QEMU guide](docs/windows-qemu.md) or
[Windows VMware guide](docs/windows-vmware.md) for your OS, and the
[CLI reference](docs/cli.md) for every command and option.

> Tip: `agent-dev-env doctor` checks Tart/QEMU/Fusion/oras and free disk
> before you start; the per-platform guides list the official install
> commands.

## Guides

Pick the guide for your operating system:

| Operating system | Guide |
| --- | --- |
| macOS (Apple Silicon) | [Set up your macOS sandbox](docs/macos.md) |
| Ubuntu (VMware) | [Set up your Ubuntu sandbox](docs/ubuntu-vmware.md) |
| Windows (QEMU) | [Set up your Windows sandbox](docs/windows-qemu.md) |
| Windows (VMware) | [Set up your Windows VMware sandbox](docs/windows-vmware.md) |

Each guide starts with a short quick setup — macOS takes four steps, the
others three — and is all you need to have a sandbox with a coding agent
running.

## Documentation

User guides and reference:

- [docs/cli.md](docs/cli.md) — the `agent-dev-env` CLI reference: commands,
  options, environment variables, paths.
- [docs/macos.md](docs/macos.md) — user guide: pull, run, share code, run
  the agent (macOS guest).
- [docs/ubuntu-vmware.md](docs/ubuntu-vmware.md) — Ubuntu 24.04 (ARM64)
  guest under VMware Fusion.
- [docs/windows-qemu.md](docs/windows-qemu.md) — Windows 11 (ARM64) guest
  under QEMU.
- [docs/windows-vmware.md](docs/windows-vmware.md) — Windows 11 (ARM64)
  guest under VMware Fusion.
- [docs/ssh-agent.md](docs/ssh-agent.md) — how the SSH agent bridge shares
  the host's passwords manager (Bitwarden, 1Password, ...) with the
  sandbox.

Image recipes — per-platform build/publish commands:

- [images/mac/README.md](images/mac/README.md) — macOS images.
- [images/windows-arm64-qemu/README.md](images/windows-arm64-qemu/README.md)
  — Windows 11 ARM64 under QEMU.
- [images/windows-arm64-vmware/README.md](images/windows-arm64-vmware/README.md)
  — Windows 11 ARM64 under VMware.
- [images/ubuntu-arm64-vmware/README.md](images/ubuntu-arm64-vmware/README.md)
  — Ubuntu 24.04 ARM64 under VMware.

For maintainers and contributors:

- [AGENTS.md](AGENTS.md) — project map, how to build and use the CLI and
  the images, releases/tags/changelogs, code guidelines.
- [DEVELOPMENT.md](DEVELOPMENT.md) — prerequisites and how to build and
  debug the CLI and the recipes.
- [CHANGELOG.md](CHANGELOG.md) — the repo changelog.
