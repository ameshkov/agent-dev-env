// runners/bridges.ts — the host side of the SSH agent + Docker bridges:
// socket discovery, the port probe (the legacy "is a listener already
// bound" check), and the detached spawn of the bundled bridge.js (the
// socat replacement). The guest side lives in the
// per-platform guest agents (launchd/schtasks/systemd).
//
// The bridge is spawned detached with a pidfile under the logs/state dir
// and keeps running after the CLI exits (the VM needs it while it runs);
// `stop` kills it by pidfile. The pidfile is keyed by role + port +
// instance so multiple sandbox instances never share a bridge. A foreign
// listener on the port (not our pidfile) is a port conflict — the
// caller must die with a SANDBOX_*_PORT hint instead of reusing it.

import net from 'node:net';
import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlive, killTree, readPidFile, spawnDetached } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';

export type BridgeRole = 'ssh-agent' | 'docker';

/** The bundled bridge entry — where copy-assets.mjs puts it. */
function bridgeJsPath(): string {
  // dist/runners/bridges.js -> dist/assets/bridge/bridge.js
  return fileURLToPath(new URL('../assets/bridge/bridge.js', import.meta.url));
}

/** @internal — pidfile for a host bridge (logs/state dir). The instance
 *  name is part of the key: two instances may use different ports and we
 *  must never confuse their bridges.
 */
export function bridgePidFile(role: BridgeRole, port: number, instance: string): string {
  return join(paths.logs, `bridge-${role}-${port}-${instance}.pid`);
}

/** @internal — log file for a host bridge. */
export function bridgeLogFile(role: BridgeRole, port: number, instance: string): string {
  return join(paths.logs, `bridge-${role}-${port}-${instance}.log`);
}

/** Whether the pidfile for a bridge belongs to a live bridge.js process.
 *
 * @param pidFile - The pidfile path.
 * @returns True when the recorded pid is alive.
 */
function bridgePidAlive(pidFile: string): boolean {
  const pid = readPidFile(pidFile);
  return pid !== undefined && isAlive(pid);
}

/** Whether the path is a Unix socket. */
function isUnixSocket(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

/** The host's SSH agent socket when it is overridden by a password
 *  manager's agent (Bitwarden, 1Password, ...). The stock macOS launchd
 *  agent (a socket under /var/run/com.apple.launchd.*) is NOT bridged.
 *
 * @param env - Environment (SSH_AUTH_SOCK).
 * @param home - Host home directory (unused, kept for signature parity).
 * @returns The socket path, or undefined when nothing is bridged.
 */
export function findHostAgentSocket(
  env: Record<string, string | undefined> = process.env,
  _home: string = process.env.HOME ?? '',
): string | undefined {
  const sock = env.SSH_AUTH_SOCK;
  if (!sock || /^\/var\/run\/com\.apple\.launchd\..*\/Listeners$/.test(sock)) {
    return undefined;
  }
  if (isUnixSocket(sock)) {
    return sock;
  }
  logger.warn(`SSH_AUTH_SOCK points to '${sock}', but no such socket exists.`);
  return undefined;
}

/** The host's Docker engine socket — the engines the sandbox supports:
 *  Docker Desktop (4.30+), Colima, OrbStack, then the legacy /var/run.
 *  The system-wide candidate is injectable so tests can be deterministic
 *  on any host (Linux CI runners always expose /var/run/docker.sock).
 *
 * @param home - Host home directory.
 * @param systemSocket - System-wide Docker socket candidate.
 * @returns The socket path, or undefined when no engine is running.
 */
export function findHostDockerSocket(
  home: string,
  systemSocket = '/var/run/docker.sock',
): string | undefined {
  const candidates = [
    join(home, '.docker', 'run', 'docker.sock'),
    join(home, '.colima', 'default', 'docker.sock'),
    join(home, '.orbstack', 'run', 'docker.sock'),
    systemSocket,
  ];
  return candidates.find((candidate) => isUnixSocket(candidate));
}

/** @internal — TCP probe: can a client connect to host:port?
 *
 * @param host - Bind/target host.
 * @param port - TCP port.
 * @param timeoutMs - Probe timeout (default 1000).
 * @returns True when a connection is accepted.
 */
export function canConnectTcp(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

export type StartBridgeResult =
  | { state: 'already-up' }
  | { state: 'started'; pid: number }
  | { state: 'conflict' }
  | { state: 'failed' };

/** Spawns the detached host bridge (or reports it is already up).
 *
 * @param args - role (pidfile/log naming), bind host + port, the forward
 *   socket (unix path on the host) and the instance key.
 * @returns The outcome; `already-up` reuses the bridge this instance owns
 *   (live pidfile), `conflict` means the port serves a foreign listener
 *   (another instance or process) — the caller must stop/die.
 */
export async function startHostBridge(args: {
  role: BridgeRole;
  bindHost: string;
  port: number;
  forwardSocket: string;
  instance: string;
}): Promise<StartBridgeResult> {
  const pidFile = bridgePidFile(args.role, args.port, args.instance);
  if (await canConnectTcp(args.bindHost, args.port)) {
    if (bridgePidAlive(pidFile)) {
      logger.ok(
        `A listener is already bound to TCP port ${args.port} — assuming the bridge is up.`,
      );
      return { state: 'already-up' };
    }
    logger.warn(
      `TCP port ${args.port} already has a listener that is not this instance\u2019s bridge.`,
    );
    return { state: 'conflict' };
  }

  const pid = spawnDetached(
    process.execPath,
    [
      bridgeJsPath(),
      '--listen',
      `tcp:${args.bindHost}:${args.port}`,
      '--forward',
      `unix:${args.forwardSocket}`,
      '--pidfile',
      pidFile,
    ],
    { logFile: bridgeLogFile(args.role, args.port, args.instance) },
  );
  if (pid <= 0) {
    logger.warn('host bridge failed to start — check the agent socket path.');
    return { state: 'failed' };
  }

  // Give the bridge a moment to bind; a dead socket path makes the
  // listener exit immediately (the legacy `kill -0` sleep-1 check).
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (!isAlive(pid) && !readPidFile(pidFile)) {
    rmSync(pidFile, { force: true });
    logger.warn('host bridge exited immediately — check the agent socket path.');
    return { state: 'failed' };
  }
  logger.ok(`Host bridge is up (pid ${pid}).`);
  return { state: 'started', pid };
}

/** The die-message for a port conflict (the SANDBOX_*_PORT env vars are
 *  the per-instance escape hatch).
 *
 * @param role - The bridge role.
 * @param instance - The instance name.
 * @param port - The TCP port that is taken.
 * @returns The message.
 */
export function bridgeConflictMessage(role: BridgeRole, instance: string, port: number): string {
  const envVar = role === 'ssh-agent' ? 'SANDBOX_AGENT_PORT' : 'SANDBOX_DOCKER_PORT';
  return (
    `TCP port ${port} is already serving another sandbox — the bridge for ` +
    `instance '${instance}' cannot start. Set ${envVar} to a free port for ` +
    'this instance (see docs/cli.md).'
  );
}

/** Stops the detached bridge for a role: pidfile → killTree, pidfile
 *  removed. No-op when nothing is running (idempotent, like the legacy
 *  stop script's "no listener" branch).
 *
 * @param role - The bridge role.
 * @param port - The bridge port.
 * @param instance - The instance name.
 * @returns The pid when something was stopped, undefined otherwise.
 */
export async function stopHostBridge(
  role: BridgeRole,
  port: number,
  instance: string,
): Promise<number | undefined> {
  const pidFile = bridgePidFile(role, port, instance);
  const pid = readPidFile(pidFile);
  if (pid !== undefined && isAlive(pid)) {
    await killTree(pid);
    rmSync(pidFile, { force: true });
    return pid;
  }
  rmSync(pidFile, { force: true });
  return undefined;
}

/** Ensures the logs/state dir exists (pidfiles + logs for the bridges
 *  and the tart run log).
 */
export function ensureBridgeDir(): void {
  mkdirSync(dirname(bridgePidFile('ssh-agent', 4100, 'default-agent-dev-env')), {
    recursive: true,
  });
}
