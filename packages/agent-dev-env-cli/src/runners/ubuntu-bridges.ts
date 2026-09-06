// runners/ubuntu-bridges.ts — step 3 for the Ubuntu backend: the host
// side of the SSH agent + Docker bridges, bound to the host's address on
// the guest's NAT segment (the shell's find_host_alias — Fusion's NAT is
// userspace; the guest gateway x.y.z.2 is vmnetd and does not forward to
// the host loopback, so the bridges bind the host's x.y.z.1 instead of a
// gateway). The guest side (upload/install/status over ssh2) lives in
// ubuntu-guest.ts, the rules step in ubuntu-rules.ts.

import { sleep } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { findHostAlias } from '../lib/network.js';
import { openSshSession, type SshSession } from '../lib/ssh.js';
import { findHostAgentSocket, findHostDockerSocket, startHostBridge } from './bridges.js';
import { bridgeConflictMessage } from './bridges.js';
import type { RunContext, RunState } from './framework.js';
import {
  ensureGuestAgent,
  findGuestNode,
  readGuestStatus,
  resolveGuestCredentials,
} from './ubuntu-guest.js';
import { installLinuxAgentRules } from './ubuntu-rules.js';

/** The Ubuntu step 3: host alias → host bridges → guest agent → guest
 *  bridges → rules. Unlike macOS (Tart gateway), every bridge here binds
 *  the host's NAT-segment address, resolved once and reused.
 */
export async function ubuntuBridges(context: RunContext, state: RunState): Promise<void> {
  const ip = state.vmIp;
  if (!ip) {
    logger.warn('no guest IP — skipping the host bridges, guest setup and rules.');
    return;
  }
  const hostAlias = await findHostAlias(ip);
  if (!hostAlias) {
    logger.warn('could not determine the host NAT-segment address — skipping the bridges.');
    return;
  }
  const creds = resolveGuestCredentials(context.image, context.options.env, ip);
  const session = await openSshSession(creds);
  try {
    const node = await findGuestNode(session);
    if (!node) {
      logger.warn('node not found in the guest — skipping the guest bridges and rules.');
      return;
    }

    if (context.options.noAgent) {
      logger.info('Skipping SSH agent bridge setup (--no-agent).');
    } else {
      await setupSshAgent(context, state, hostAlias);
    }
    if (context.options.noDocker) {
      logger.info('Skipping Docker bridge setup (--no-docker).');
    } else {
      await setupDockerBridge(context, state, hostAlias);
    }

    const anyBridged = state.bridges.agent.bridged || state.bridges.docker.bridged;
    if (anyBridged) {
      await ensureGuestAgent(session, node, hostAlias, context);
      await readGuestStatus(session, state, node);
      reportBridgeState(context, state);
      if (state.bridges.docker.bridged && state.bridges.docker.guestUp) {
        await verifyGuestDocker(session, state);
      }
    }

    await installLinuxAgentRules(context, state, session, node, hostAlias);
  } finally {
    session.end();
  }
}

async function setupSshAgent(
  context: RunContext,
  state: RunState,
  hostAlias: string,
): Promise<void> {
  const sock = findHostAgentSocket(context.options.env, context.options.home);
  if (!sock) {
    logger.info('No SSH agent override detected — using the default macOS agent.');
    logger.info(
      'To share a password manager\u2019s agent (Bitwarden, 1Password, ...), ' +
        'enable its SSH agent on the host and re-run.',
    );
    return;
  }
  logger.ok(`Host SSH agent socket found: ${sock}`);
  logger.info(
    `Bridging it into the guest on TCP port ${context.agentPort} (see docs/ssh-agent.md).`,
  );
  logger.ok(`Guest reaches the host at ${hostAlias}`);

  if (!(await startBridge(context, state, 'ssh-agent', sock, hostAlias))) {
    return;
  }
}

async function setupDockerBridge(
  context: RunContext,
  state: RunState,
  hostAlias: string,
): Promise<void> {
  const sock = findHostDockerSocket(context.options.home);
  if (!sock) {
    logger.info('No Docker engine socket found on the host (Docker Desktop, Colima, OrbStack).');
    logger.info('Start an engine on the host and re-run to bridge it into the guest.');
    return;
  }
  logger.ok(`Host Docker engine socket found: ${sock}`);
  logger.info(`Bridging it into the guest on TCP port ${context.dockerPort}.`);
  logger.ok(`Guest reaches the host at ${hostAlias}`);

  if (!(await startBridge(context, state, 'docker', sock, hostAlias))) {
    return;
  }
}

/** The shared bridge start: the host spawn + state bookkeeping (the
 *  shell's start_host_bridge; pidfile + detached bridge.js via
 *  runners/bridges.ts — no socat). Returns false when skipped/conflicted.
 */
async function startBridge(
  context: RunContext,
  state: RunState,
  role: 'ssh-agent' | 'docker',
  socket: string,
  hostAlias: string,
): Promise<boolean> {
  const port = role === 'ssh-agent' ? context.agentPort : context.dockerPort;
  const result = await startHostBridge({
    role,
    bindHost: hostAlias,
    port,
    forwardSocket: socket,
    instance: context.instance,
  });
  if (result.state === 'conflict') {
    logger.die(bridgeConflictMessage(role, context.instance, port));
  }
  if (result.state === 'failed') {
    logger.warn(`skipping the ${role === 'ssh-agent' ? 'SSH agent' : 'Docker'} bridge.`);
    return false;
  }
  const bridge = role === 'ssh-agent' ? state.bridges.agent : state.bridges.docker;
  bridge.bridged = true;
  bridge.socket = socket;
  bridge.pid = result.state === 'started' ? result.pid : undefined;
  return true;
}

function reportBridgeState(context: RunContext, state: RunState): void {
  const agent = state.bridges.agent;
  if (agent.bridged) {
    if (agent.guestUp) {
      logger.ok(`Guest bridge is up: /tmp/ssh-agent.sock -> host TCP ${context.agentPort}`);
    } else {
      logger.warn(
        'guest bridge did not start — run the guest commands from docs/ssh-agent.md manually.',
      );
    }
  }
  const docker = state.bridges.docker;
  if (docker.bridged) {
    if (docker.guestUp) {
      logger.ok(`Guest Docker bridge is up: /tmp/docker.sock -> host TCP ${context.dockerPort}`);
    } else {
      logger.warn('guest Docker bridge did not start — check the guest agent install.');
    }
  }
}

/** End-to-end check: can the guest's docker CLI reach the host engine
 *  through the bridge? Retries briefly (the engine may still be
 *  starting), like the shell's verify_guest_docker (15 x 1 s).
 */
async function verifyGuestDocker(session: SshSession, state: RunState): Promise<void> {
  const probe = 'bash -lc \'docker info --format "{{.ServerVersion}}"\'';
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const res = await session.exec(probe, { timeoutMs: 20_000 });
    const version = res.code === 0 ? res.stdout.trim() : '';
    if (version) {
      state.bridges.docker.serverVersion = version;
      state.bridges.docker.engineUp = true;
      logger.ok(`Docker engine is reachable from the guest (server version ${version}).`);
      return;
    }
    await sleep(1000);
  }
  logger.warn('Docker engine not reachable from the guest yet — is it running on the host?');
  logger.warn('The bridge reconnects on its own once it is; re-run to re-check.');
}
