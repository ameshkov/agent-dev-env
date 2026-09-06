// index.ts — guest-agent-ubuntu CLI. Runs inside the Ubuntu 24.04 sandbox
// guest (bundled single-file, node-only): installs/bridges the host SSH
// agent and Docker engine into the guest (systemd user units) and manages
// the agent rules.
//
//   guest-agent-ubuntu install [--agent-port N] [--docker-port N] [--host-alias A]
//   guest-agent-ubuntu bridge <ssh-agent|docker> [--listen EP] [--forward EP] [--port N]
//   guest-agent-ubuntu status
//   guest-agent-ubuntu rules [--force]
//   guest-agent-ubuntu uninstall
//
// The /etc/profile.d env script needs root: run `install` once through
// sudo (`sudo -S node guest-agent-ubuntu.js install …`) or the agent
// writes the user-level exports to ~/.profile (login shells) and
// ~/.bashrc (interactive terminals) instead and reports the difference.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBridge } from 'bridge-core';
import { parseEndpoint } from 'bridge-core/endpoints';
import { canConnect } from 'bridge-core/probe';
import { applyRules, rulesAction } from 'guest-rules';
import {
  PROFILE_D_PATH,
  profileDScript,
  systemdUnit,
  UBUNTU_SOCKETS,
  type SystemdBridge,
} from './systemd.js';

const AGENT_PATH = fileURLToPath(import.meta.url);
const NODE_PATH = process.execPath;
const HOME = homedir();
const UNIT_DIR = join(HOME, '.config', 'systemd', 'user');

const DEFAULTS = {
  agentPort: 4400,
  dockerPort: 4401,
} as const;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'install':
        return install(rest);
      case 'bridge':
        return bridgeCommand(rest);
      case 'status':
        return status();
      case 'rules':
        return rulesCommand(rest);
      case 'uninstall':
        return uninstall();
      default:
        process.stderr.write(usage());
        return 1;
    }
  } catch (err) {
    process.stderr.write(`guest-agent-ubuntu: ${(err as Error).message}\n`);
    return 1;
  }
}

function usage(): string {
  return [
    'usage: guest-agent-ubuntu <install|bridge|status|rules|uninstall> [options]',
    '  install [--agent-port N] [--docker-port N] [--host-alias A]',
    '  bridge <ssh-agent|docker> [--listen EP] [--forward EP] [--port N] [--host-alias A]',
    '  rules [--force]  (content on stdin)',
    '',
  ].join('\n');
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function bridgeFor(role: 'ssh-agent' | 'docker', port: number, hostAlias: string): SystemdBridge {
  return {
    unitName: `agent-dev-env-${role}.service`,
    description:
      role === 'ssh-agent' ? 'Agent Dev Env SSH agent bridge' : 'Agent Dev Env Docker bridge',
    nodePath: NODE_PATH,
    agentPath: AGENT_PATH,
    role,
    port,
    hostAlias,
    socket: UBUNTU_SOCKETS[role],
  };
}

function install(argv: string[]): number {
  const hostAlias =
    argValue(argv, '--host-alias') ??
    (() => {
      throw new Error('--host-alias is required (the NAT router address)');
    })();
  const agentPort = Number(argValue(argv, '--agent-port') ?? DEFAULTS.agentPort);
  const dockerPort = Number(argValue(argv, '--docker-port') ?? DEFAULTS.dockerPort);

  mkdirSync(UNIT_DIR, { recursive: true });
  for (const [role, port] of [
    ['ssh-agent', agentPort],
    ['docker', dockerPort],
  ] as const) {
    const bridge = bridgeFor(role, port, hostAlias);
    writeFileSync(join(UNIT_DIR, bridge.unitName), systemdUnit(bridge));
    process.stdout.write(`installed:${role} (${bridge.unitName}, port ${port})\n`);
  }
  execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  for (const [role] of [['ssh-agent'], ['docker']] as const) {
    execFileSync('systemctl', ['--user', 'enable', '--now', `agent-dev-env-${role}.service`], {
      stdio: 'ignore',
    });
  }

  installProfileExports(hostAlias);
  return 0;
}

/** The files the bridge env block must land in:
 *  - root: /etc/profile.d (every login shell) + the sudo caller's
 *    ~/.bashrc (interactive terminals),
 *  - the sandbox user: ~/.profile (login shells — ssh sessions) and
 *    ~/.bashrc (the interactive non-login shells the GNOME Terminal
 *    opens; a terminal never sources ~/.profile, so without ~/.bashrc
 *    the bridges would be invisible there — SSH would fall back to key
 *    files and fail with "Permission denied (publickey)").
 *
 * @internal — exported for the co-located unit tests.
 *
 * @param isRoot - Whether the agent runs as uid 0.
 * @param home - The invoker's home.
 * @param sudoUser - The sudo caller (`SUDO_USER`) when root.
 * @returns The files the env block must land in, in write order.
 */
export function envBlockTargets(isRoot: boolean, home: string, sudoUser?: string): string[] {
  if (isRoot) {
    return [PROFILE_D_PATH, ...(sudoUser ? [`/home/${sudoUser}/.bashrc`] : [])];
  }
  return [join(home, '.profile'), join(home, '.bashrc')];
}

/** /etc/profile.d when root; otherwise the user's ~/.profile and
 *  ~/.bashrc (login + interactive shells; see envBlockTargets). */
function installProfileExports(gw: string): void {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const block = profileDScript(gw);
  for (const target of envBlockTargets(isRoot, HOME, isRoot ? process.env.SUDO_USER : undefined)) {
    if (target === PROFILE_D_PATH) {
      writeFileSync(PROFILE_D_PATH, block);
      process.stdout.write(`installed:profile.d (${PROFILE_D_PATH})\n`);
    } else {
      appendEnvBlock(target, block);
      process.stdout.write(`installed:profile.d (user ${target})\n`);
    }
  }
}

/** Appends the marker-guarded env block when it is not present yet. */
function appendEnvBlock(path: string, block: string): void {
  const content = readMaybe(path);
  if (!content.includes(profileMarker())) {
    writeFileSync(path, `${content}${block}`);
  }
}

function profileMarker(): string {
  return '# Agent dev env bridge env';
}

function bridgeCommand(argv: string[]): Promise<number> {
  const role = argv[0];
  if (role !== 'ssh-agent' && role !== 'docker') {
    throw new Error(`unknown bridge role '${role}' (ssh-agent|docker)`);
  }
  const port = Number(
    argValue(argv, '--port') ?? DEFAULTS[role === 'ssh-agent' ? 'agentPort' : 'dockerPort'],
  );
  const hostAlias =
    argValue(argv, '--host-alias') ??
    (() => {
      throw new Error('--host-alias is required (the NAT router address)');
    })();
  const listen = argValue(argv, '--listen') ?? `unix:${UBUNTU_SOCKETS[role]}`;
  const forward = argValue(argv, '--forward') ?? `tcp:${hostAlias}:${port}`;
  return runBridge({
    listen: parseEndpoint(listen),
    forward: parseEndpoint(forward),
    log: (message) => process.stderr.write(`${message}\n`),
  });
}

async function status(): Promise<number> {
  const agentUp = await canConnect(parseEndpoint(`unix:${UBUNTU_SOCKETS['ssh-agent']}`));
  const dockerUp = await canConnect(parseEndpoint(`unix:${UBUNTU_SOCKETS.docker}`));
  process.stdout.write(`bridge-status:ssh-agent=${agentUp ? 'up' : 'down'}\n`);
  process.stdout.write(`bridge-status:docker=${dockerUp ? 'up' : 'down'}\n`);
  return 0;
}

function rulesCommand(argv: string[]): number {
  const content = readFileSync(0, 'utf8');
  if (argv.includes('--force')) {
    applyRules(HOME, content);
    process.stdout.write('rules:overwritten\n');
  } else {
    process.stdout.write(`rules:probe=${rulesAction(HOME, content)}\n`);
  }
  return 0;
}

function uninstall(): number {
  for (const role of ['ssh-agent', 'docker'] as const) {
    const unit = `agent-dev-env-${role}.service`;
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', unit], { stdio: 'ignore' });
    } catch {
      // not running/installed — nothing to stop
    }
    rmSync(join(UNIT_DIR, unit), { force: true });
  }
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (isRoot) {
    rmSync(PROFILE_D_PATH, { force: true });
  }
  const rcFiles = isRoot
    ? process.env.SUDO_USER
      ? [`/home/${process.env.SUDO_USER}/.bashrc`]
      : []
    : [join(HOME, '.profile'), join(HOME, '.bashrc')];
  for (const rcFile of rcFiles) {
    if (existsSync(rcFile)) {
      const cleaned = removeProfileBlock(readMaybe(rcFile));
      if (cleaned !== readMaybe(rcFile)) {
        writeFileSync(rcFile, cleaned);
      }
    }
  }
  process.stdout.write('uninstalled:ssh-agent,docker\n');
  return 0;
}

/** Removes the marker-guarded env block (blank separator line through
 *  the block's trailing blank line) from ~/.profile. */
export function removeProfileBlock(content: string): string {
  const lines = content.split('\n');
  const markerIndex = lines.findIndex((line) => line.startsWith(profileMarker()));
  if (markerIndex === -1) {
    return content;
  }
  const blockStart =
    markerIndex > 0 && lines[markerIndex - 1] === '' ? markerIndex - 1 : markerIndex;
  let blockEnd = markerIndex + 1;
  while (blockEnd < lines.length && lines[blockEnd] !== '') {
    blockEnd += 1;
  }
  if (blockEnd < lines.length) {
    blockEnd += 1; // the block's trailing blank line
  }
  return [...lines.slice(0, blockStart), ...lines.slice(blockEnd)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function readMaybe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
