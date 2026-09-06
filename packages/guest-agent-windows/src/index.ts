// index.ts — guest-agent-windows CLI. Runs inside the Windows 11 (ARM64)
// sandbox guest (bundled single-file, node-only): installs/bridges the
// host SSH agent and Docker engine into the guest over named pipes
// (schtasks at logon) and reports bridge status.
//
//   guest-agent-windows install [--agent-port N] [--docker-port N] --host-alias A
//   guest-agent-windows bridge <ssh-agent|docker> [--listen EP] [--forward EP] [--port N]
//   guest-agent-windows status
//   guest-agent-windows uninstall
//
// Shared by the QEMU and VMware Windows backends: only the host alias
// differs (10.0.2.2 vs the NAT router x.y.z.1).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBridge } from 'bridge-core';
import { parseEndpoint } from 'bridge-core/endpoints';
import { canConnect } from 'bridge-core/probe';
import {
  dockerContextCommands,
  relayStartCommand,
  schtasksXml,
  userEnvCommand,
  WINDOWS_PIPES,
  WINDOWS_TASK_NAMES,
  type WindowsTask,
} from './schtasks.js';

const AGENT_PATH = fileURLToPath(import.meta.url);
const NODE_PATH = process.execPath;

const DEFAULTS = {
  agentPort: 4300,
  dockerPort: 4301,
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
      case 'uninstall':
        return uninstall();
      default:
        process.stderr.write(usage());
        return 1;
    }
  } catch (err) {
    process.stderr.write(`guest-agent-windows: ${(err as Error).message}\n`);
    return 1;
  }
}

function usage(): string {
  return [
    'usage: guest-agent-windows <install|bridge|status|uninstall> [options]',
    '  install [--agent-port N] [--docker-port N] --host-alias A',
    '  bridge <ssh-agent|docker> [--listen EP] [--forward EP] [--port N] [--host-alias A]',
    '',
  ].join('\n');
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function taskFor(role: 'ssh-agent' | 'docker', port: number, hostAlias: string): WindowsTask {
  return {
    taskName: WINDOWS_TASK_NAMES[role],
    description:
      role === 'ssh-agent' ? 'Agent Dev Env SSH agent bridge' : 'Agent Dev Env Docker bridge',
    nodePath: NODE_PATH,
    agentPath: AGENT_PATH,
    role,
    pipe: WINDOWS_PIPES[role],
    port,
    hostAlias,
  };
}

function install(argv: string[]): number {
  const hostAlias = argValue(argv, '--host-alias');
  if (!hostAlias) {
    throw new Error('--host-alias is required (10.0.2.2 for QEMU, the NAT router otherwise)');
  }
  const agentPort = Number(argValue(argv, '--agent-port') ?? DEFAULTS.agentPort);
  const dockerPort = Number(argValue(argv, '--docker-port') ?? DEFAULTS.dockerPort);

  const tasks: WindowsTask[] = [];
  for (const [role, port] of [
    ['ssh-agent', agentPort],
    ['docker', dockerPort],
  ] as const) {
    const task = taskFor(role, port, hostAlias);
    tasks.push(task);
    const xmlPath = join(tmpdir(), `${task.taskName}.xml`);
    // schtasks rejects a BOM-less UTF-16 file ("The task XML is
    // malformed. (1,2):: one root element") — the \uFEFF prefix becomes
    // the FE FF byte-order mark in utf16le.
    writeFileSync(xmlPath, '\uFEFF' + schtasksXml(task), 'utf16le');
    try {
      execFileSync('schtasks', ['/Create', '/TN', task.taskName, '/XML', xmlPath, '/F'], {
        stdio: 'ignore',
      });
      process.stdout.write(`installed:${role} (task ${task.taskName}, port ${port})\n`);
    } finally {
      rmSync(xmlPath, { force: true });
    }
  }

  startRelays(tasks);
  setUserEnv('SSH_AUTH_SOCK', WINDOWS_PIPES['ssh-agent']);
  setupDockerContext();
  return 0;
}

/** Starts both bridge relays right away: the ONLOGON tasks fire only at
 *  the next logon, so a fresh install would otherwise report the pipes
 *  down until the guest reboots. The relays must run detached from the
 *  sshd session (its job would kill them on teardown) — the legacy
 *  mechanism: a SYSTEM ONCE task started with `schtasks /Run` (ONLOGON
 *  tasks silently no-op on /Run). start-relays.cmd is rewritten next to
 *  the agent with this run's ports + alias.
 *
 * @param tasks - The registered bridge tasks.
 */
function startRelays(tasks: WindowsTask[]): void {
  const dir = dirname(AGENT_PATH);
  const cmdPath = join(dir, 'start-relays.cmd');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(cmdPath, relayStartCommand(NODE_PATH, AGENT_PATH, tasks));
    execFileSync(
      'schtasks',
      [
        '/Create',
        '/TN',
        WINDOWS_TASK_NAMES.relays,
        '/SC',
        'ONCE',
        '/ST',
        '00:00',
        '/RU',
        'SYSTEM',
        '/RL',
        'HIGHEST',
        '/F',
        '/TR',
        cmdPath,
      ],
      { stdio: 'ignore' },
    );
    execFileSync('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAMES.relays], { stdio: 'ignore' });
    process.stdout.write('installed:relays (started via a system task)\n');
  } catch (err) {
    process.stderr.write(
      `warning: could not start the relays right away (${(err as Error).message}) — ` +
        'they start at the next logon\n',
    );
  }
}

function setUserEnv(name: string, value: string): void {
  const cmd = userEnvCommand(name, value);
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    stdio: 'ignore',
  });
  process.stdout.write(`installed:env ${name}\n`);
}

function setupDockerContext(): void {
  const docker = spawnSync('where.exe', ['docker'], { encoding: 'utf8' });
  if (docker.status !== 0) {
    process.stderr.write('warning: docker CLI not found — skipping the docker context\n');
    return;
  }
  for (const command of dockerContextCommands()) {
    spawnSync('cmd.exe', ['/c', command], { stdio: 'ignore' });
  }
  process.stdout.write('installed:docker context host\n');
}

function bridgeCommand(argv: string[]): Promise<number> {
  const role = argv[0];
  if (role !== 'ssh-agent' && role !== 'docker') {
    throw new Error(`unknown bridge role '${role}' (ssh-agent|docker)`);
  }
  const port = Number(
    argValue(argv, '--port') ?? DEFAULTS[role === 'ssh-agent' ? 'agentPort' : 'dockerPort'],
  );
  const hostAlias = argValue(argv, '--host-alias');
  if (!hostAlias) {
    throw new Error('--host-alias is required');
  }
  const listen = argValue(argv, '--listen') ?? `pipe:${WINDOWS_PIPES[role]}`;
  const forward = argValue(argv, '--forward') ?? `tcp:${hostAlias}:${port}`;
  return runBridge({
    listen: parseEndpoint(listen),
    forward: parseEndpoint(forward),
    log: (message) => process.stderr.write(`${message}\n`),
  });
}

async function status(): Promise<number> {
  const agentUp = await canConnect(parseEndpoint(`pipe:${WINDOWS_PIPES['ssh-agent']}`));
  const dockerUp = await canConnect(parseEndpoint(`pipe:${WINDOWS_PIPES.docker}`));
  process.stdout.write(`bridge-status:ssh-agent=${agentUp ? 'up' : 'down'}\n`);
  process.stdout.write(`bridge-status:docker=${dockerUp ? 'up' : 'down'}\n`);
  return 0;
}

function uninstall(): number {
  for (const role of ['ssh-agent', 'docker'] as const) {
    const taskName = WINDOWS_TASK_NAMES[role];
    try {
      execFileSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' });
    } catch {
      // not installed — nothing to delete
    }
  }
  try {
    execFileSync('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAMES.relays, '/F'], {
      stdio: 'ignore',
    });
  } catch {
    // not installed — nothing to delete
  }
  rmSync(join(dirname(AGENT_PATH), 'start-relays.cmd'), { force: true });
  const cmd = userEnvCommand('SSH_AUTH_SOCK', '');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      stdio: 'ignore',
    });
  } catch {
    // env var already gone
  }
  process.stdout.write('uninstalled:ssh-agent,docker\n');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
