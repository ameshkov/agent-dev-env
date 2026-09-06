# Sharing the SSH agent with the sandbox

Your SSH keys can live in a password manager on the host — Bitwarden,
1Password, KeePassXC, ... — while the coding agent inside the sandbox VM
uses them for `git push`, `ssh`, `scp`, and anything else that needs
authentication. This guide explains how the `agent-dev-env` CLI exposes
the host's SSH agent socket to the guest.

## Why a shared directory won't work

`SSH_AUTH_SOCK` points to a Unix domain socket. The socket "file" is only a
pointer to a socket endpoint inside the kernel of the machine that created
it (your host). A directory mount (`--work-dir`, virtiofs/HGFS) moves file
contents, not kernel objects — so mounting the directory that contains the
socket and pointing `SSH_AUTH_SOCK` at it fails
(`connect: No such file or directory`). The guest needs a **real socket in
its own kernel**, backed by a transport to the host.

## How the CLI bridges it

```text
 guest (sandbox VM)                          host (your Mac)
 ─────────────────                           ─────────────────
 git / ssh / opencode
   │
   ▼
 /tmp/ssh-agent.sock  (Unix socket in guest)          SSH_AUTH_SOCK
   │                                        (Bitwarden, 1Password, ...)
 guest agent ──► TCP ──► gateway IP ──► host bridge ──► agent socket
```

The bridge is two forwarders (no socat, no shell scripts — the same bundled
`bridge.js` runs on both sides): `agent-dev-env run <platform>` detects an
*overridden* agent socket on the host and

- starts a host-side forwarder that turns the agent socket into a TCP port
  on the VM network (bound to the NAT/gateway address — not exposed to
  your LAN; loopback for the QEMU hostfwd),
- installs and starts the platform's guest agent, which creates the socket
  in the guest at a fixed path and points `SSH_AUTH_SOCK` at it
  (macOS: LaunchAgent + `~/.zprofile` + the `IdentityAgent` patch in
  `~/.ssh/config`; Ubuntu: systemd user services + `/etc/profile.d` (root)
  or `~/.profile` + `~/.bashrc` (user — `~/.bashrc` is what covers the
  interactive terminals; open a new shell after `run`;
  Windows: ONLOGON scheduled tasks + the `\\.\pipe\openssh-ssh-agent`
  named pipe), and
- verifies the bridge, so `ssh`/`git` inside the guest authenticate with
  the host's keys — **no keys are copied into the guest**.

The guest-side bridge persists (launchd/systemd/schtasks restart it at
every logon), so it survives guest reboots; the host-side listener lives
only for the run (in background mode it stays up until `stop`).

## Requirements

- The password manager must run on the host with its SSH agent enabled,
  e.g. Bitwarden: Settings → Vault → SSH Agent (approve the approval
  requests it shows, or enable auto-approval).
- Nothing to install for the bridge — `doctor` no longer checks for socat
  (the CLI's Node forwarder replaced it everywhere).

Only an *overridden* agent is bridged: with the stock macOS launchd agent
(`/tmp/...` or the default agent), there are no keys to share, so the CLI
skips the bridge. A non-default `SSH_AUTH_SOCK` (password manager's
socket) is what makes it worth bridging. Check what you have:

```bash
echo "$SSH_AUTH_SOCK"      # e.g. ~/Library/Containers/com.bitwarden.desktop/...
ssh-add -l                 # the keys the agent holds
```

## Verify

Once the sandbox is running:

```bash
sudo ssh-add -l                   # inside the guest (or `ssh-add -l`)
ssh -T git@github.com             # or whatever server you actually use
```

## Notes

- Skip the bridge for a run with `--no-agent`; `SANDBOX_AGENT_PORT`
  overrides the bridge port (defaults: macOS `4100`, Windows QEMU `4200`,
  Windows VMware `4300`, Ubuntu `4400` — so all four sandboxes can run
  side by side).
- The `IdentityAgent` patch in the guest's `~/.ssh/config` makes `ssh(1)`
  reach the bridged socket directly, so authentication keeps working even
  where `SSH_AUTH_SOCK` is not exported (cron jobs, launchd agents, GUI
  tools, `tart exec` commands).
- The host listener binds only to the VM network gateway address (or
  loopback for QEMU), so your keys are never exposed to your LAN — same
  trust model as the Docker engine bridge.
