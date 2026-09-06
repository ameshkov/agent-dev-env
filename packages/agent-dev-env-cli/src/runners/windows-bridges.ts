// runners/windows-bridges.ts — step 3 for the two Windows backends: the
// host side of the SSH agent + Docker bridges. VMware (Fusion's NAT is
// userspace — the guest gateway x.y.z.2 is vmnetd and does not forward to
// the host loopback, so the bridges bind the host's x.y.z.1 like the
// Ubuntu backend); QEMU (user-mode networking — the guest reaches the
// host loopback at 10.0.2.2, so the listeners bind 127.0.0.1). The guest
// side (upload/install/status/docker over the ssh2 PowerShell transport)
// lives in windows-guest.ts.

import { QEMU_HOST_ALIAS } from '../lib/qemu.js';
import { logger } from '../lib/logger.js';
import { findHostAlias } from '../lib/network.js';
import { openSshSession } from '../lib/ssh.js';
import { findHostAgentSocket, findHostDockerSocket, startHostBridge } from './bridges.js';
import { bridgeConflictMessage } from './bridges.js';
import type { RunContext, RunState } from './framework.js';
import {
  ensureGuestAgent,
  findGuestNode,
  readGuestStatus,
  resolveGuestCredentials,
  verifyGuestDocker,
} from './windows-guest.js';

/** The Windows step 3: host alias → host bridges → guest agent → guest
 *  bridges → docker verification. The guest-visible alias and the bind
 *  address differ per backend (QEMU: 10.0.2.2 / 127.0.0.1; VMware: the
 *  NAT-segment x.y.z.1 / itself), resolved once and reused.
 */
export async function windowsBridges(context: RunContext, state: RunState): Promise<void> {
  const isQemu = context.platform === 'windows-qemu';
  // The QEMU backend reaches the guest through the hostfwd loopback (the
  // guest's NAT IP is not host-visible), so its bridge wiring needs no
  // VMware guest-IP discovery — without the fallback the shared step
  // (which branches on state.vmIp) skipped the whole setup after boot.
  const ip = isQemu ? '127.0.0.1' : state.vmIp;
  if (!ip) {
    logger.warn('no guest IP — skipping the host bridges and guest setup.');
    return;
  }
  const guestAlias = isQemu ? QEMU_HOST_ALIAS : await findHostAlias(ip);
  if (!guestAlias) {
    logger.warn('could not determine the host NAT-segment address — skipping the bridges.');
    return;
  }
  const bindHost = isQemu ? '127.0.0.1' : guestAlias;
  const creds = resolveGuestCredentials(
    context.image,
    context.options.env,
    ip,
    context.options.sshPort,
  );
  const session = await openSshSession(creds);
  try {
    const node = await findGuestNode(session);
    if (!node) {
      logger.warn('node not found in the guest — skipping the guest bridges.');
      return;
    }

    if (context.options.noAgent) {
      logger.info('Skipping SSH agent bridge setup (--no-agent).');
    } else {
      await setupSshAgent(context, state, bindHost, guestAlias);
    }
    if (context.options.noDocker) {
      logger.info('Skipping Docker bridge setup (--no-docker).');
    } else {
      await setupDockerBridge(context, state, bindHost, guestAlias);
    }

    const anyBridged = state.bridges.agent.bridged || state.bridges.docker.bridged;
    if (anyBridged) {
      await ensureGuestAgent(session, node, guestAlias, context);
      await readGuestStatus(session, state, node);
      reportBridgeState(context, state);
      if (state.bridges.docker.bridged && state.bridges.docker.guestUp) {
        await verifyGuestDocker(session, state);
      }
    }
  } finally {
    session.end();
  }
}

async function setupSshAgent(
  context: RunContext,
  state: RunState,
  bindHost: string,
  guestAlias: string,
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
  logger.ok(`Guest reaches the host at ${guestAlias}`);

  if (!(await startBridge(context, state, 'ssh-agent', sock, bindHost))) {
    return;
  }
}

async function setupDockerBridge(
  context: RunContext,
  state: RunState,
  bindHost: string,
  guestAlias: string,
): Promise<void> {
  const sock = findHostDockerSocket(context.options.home);
  if (!sock) {
    logger.info('No Docker engine socket found on the host (Docker Desktop, Colima, OrbStack).');
    logger.info('Start an engine on the host and re-run to bridge it into the guest.');
    return;
  }
  logger.ok(`Host Docker engine socket found: ${sock}`);
  logger.info(`Bridging it into the guest on TCP port ${context.dockerPort}.`);
  logger.ok(`Guest reaches the host at ${guestAlias}`);

  if (!(await startBridge(context, state, 'docker', sock, bindHost))) {
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
  bindHost: string,
): Promise<boolean> {
  const port = role === 'ssh-agent' ? context.agentPort : context.dockerPort;
  const result = await startHostBridge({
    role,
    bindHost,
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
      logger.ok(
        `Guest bridge is up: \\\\.\\pipe\\openssh-ssh-agent -> host TCP ${context.agentPort}`,
      );
    } else {
      logger.warn(
        'guest bridge did not start — run the guest commands from docs/ssh-agent.md manually.',
      );
    }
  }
  const docker = state.bridges.docker;
  if (docker.bridged) {
    if (docker.guestUp) {
      logger.ok(
        `Guest Docker bridge is up: \\\\.\\pipe\\docker_engine -> host TCP ${context.dockerPort}`,
      );
    } else {
      logger.warn('guest Docker bridge did not start — check the guest agent install.');
    }
  }
}
