// runners/macos-guest.ts — the guest side of the macOS step 3: where the
// bundled guest agent lives, how it is uploaded over `tart exec` and how
// it is run (upload → install → status). The other step-3 concerns
// (host bridges, rules) live in their own modules; this one is the
// transport bits both need.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execVm } from '../lib/tart.js';
import { logger } from '../lib/logger.js';
import type { RunContext, RunState } from './framework.js';

/** The guest's agent install dir (image-fixed home `/Users/admin`). */
const GUEST_LIB_DIR = '/Users/admin/.local/lib/agent-dev-env';

/** The absolute guest-agent path. */
export const GUEST_AGENT = `${GUEST_LIB_DIR}/guest-agent-mac.js`;

/** The bundled macOS guest agent (single-file, node-only). */
function guestAgentPath(): string {
  return fileURLToPath(new URL('../assets/guest/guest-agent-mac.js', import.meta.url));
}

/** Uploads the bundled guest agent and runs `install` (idempotent:
 *  launchd jobs reloaded, zprofile/ssh config marker-guarded, docker
 *  context refreshed). The host alias is passed when the gateway is
 *  known; the agent falls back to the guest's netstat gateway.
 *
 * @param context - The run context (ports).
 * @param node - The guest's node binary.
 * @param gateway - The Tart gateway, when determinable.
 */
export async function ensureGuestAgent(
  context: RunContext,
  node: string,
  gateway: string | undefined,
): Promise<void> {
  const upload = await execVm(
    context.instance,
    ['sh', '-c', `mkdir -p ${GUEST_LIB_DIR} && cat > ${GUEST_AGENT}`],
    { input: readFileSync(guestAgentPath(), 'utf8') },
  );
  if (upload.code !== 0) {
    logger.warn(`could not upload the guest agent (tart exec: ${upload.code}).`);
    return;
  }
  const installArgs = [
    node,
    GUEST_AGENT,
    'install',
    '--agent-port',
    String(context.agentPort),
    '--docker-port',
    String(context.dockerPort),
  ];
  if (gateway) {
    installArgs.push('--host-alias', gateway);
  }
  const install = await execVm(context.instance, installArgs);
  if (install.code !== 0) {
    logger.warn(`guest agent install failed (tart exec: ${install.code}).`);
    return;
  }
  logger.ok('Guest agent installed (SSH agent + Docker bridges persistent).');
}

/** Runs `guest-agent status` and folds the bridge-status lines into the
 *  run state.
 *
 * @param context - The run context (VM name).
 * @param state - The accumulated run state.
 * @param node - The guest's node binary.
 */
export async function readGuestStatus(
  context: RunContext,
  state: RunState,
  node: string,
): Promise<void> {
  const res = await execVm(context.instance, [node, GUEST_AGENT, 'status']);
  if (res.code !== 0) {
    return;
  }
  for (const line of res.stdout.split('\n')) {
    const match = /^bridge-status:(ssh-agent|docker)=(up|down)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    if (match[1] === 'ssh-agent') {
      state.bridges.agent.guestUp = match[2] === 'up';
    } else {
      state.bridges.docker.guestUp = match[2] === 'up';
    }
  }
}
