// runners/ubuntu-rules.ts — the agent-rules step for the Ubuntu backend:
// render the bundled agent-rules-linux.md (extra {{NAT_GATEWAY}}
// substitution) and drive the guest agent's `rules --probe` / `rules
// --force` over ssh (the mac twin in macos-rules.ts runs over `tart
// exec`; the probe/confirm/overwrite semantics are the same). The
// sha256 marker semantics live in the guest agent (guest-rules).

import { logger } from '../lib/logger.js';
import { confirmDefault } from '../lib/prompt.js';
import type { SshSession } from '../lib/ssh.js';
import type { RunContext, RunState } from './framework.js';
import {
  loadAgentRules,
  loadHostGlobalAgents,
  mergeAgentRules,
  renderAgentRules,
} from './rules.js';
import { GUEST_AGENT } from './ubuntu-guest.js';

/** The rules asset for Ubuntu (vs agent-rules.md on macOS). */
const RULES_ASSET = 'agent-rules-linux.md';

/** The agent-rules probe/confirm/apply over ssh.
 *
 * @param context - The run context (paths to substitute).
 * @param state - The accumulated run state (bridge flags).
 * @param session - The connected guest session.
 * @param node - The guest's node binary.
 * @param hostAlias - The NAT host address ({{NAT_GATEWAY}}).
 */
export async function installLinuxAgentRules(
  context: RunContext,
  state: RunState,
  session: SshSession,
  node: string,
  hostAlias: string | undefined,
): Promise<void> {
  const content = loadAgentRules(RULES_ASSET);
  if (!content) {
    logger.warn('agent rules file not found (assets/rules/agent-rules-linux.md).');
    state.rules = 'failed';
    return;
  }
  const natGateway =
    hostAlias ?? (state.vmIp ? `${state.vmIp.split('.').slice(0, 3).join('.')}.1` : '');
  const rendered = renderAgentRules(
    content,
    {
      HOST_WORK_DIR: context.workDir || '<not shared>',
      GUEST_MOUNT: context.guestMount,
      NAT_GATEWAY: natGateway,
    },
    state.bridges.agent.bridged && state.bridges.agent.guestUp,
  );
  const merged = mergeAgentRules(loadHostGlobalAgents(), rendered);

  const probe = await session.exec(`${node} ${GUEST_AGENT} rules`, {
    input: merged,
  });
  const action = /^rules:probe=(.+)$/.exec(probe.stdout.trim())?.[1];
  if (probe.code !== 0 || !action) {
    logger.warn('could not inspect the agent rules in the guest.');
    state.rules = 'failed';
    return;
  }
  await applyRulesAction(context, state, session, node, merged, action);
}

/** The probe outcome decision tree (shell parity: install/update ask
 *  with the y default, conflict asks with the n default). */
async function applyRulesAction(
  context: RunContext,
  state: RunState,
  session: SshSession,
  node: string,
  rendered: string,
  action: string,
): Promise<void> {
  if (action === 'uptodate') {
    logger.info('Agent rules are up to date in the guest.');
    state.rules = 'uptodate';
    return;
  }
  if (action !== 'install' && action !== 'update' && action !== 'conflict') {
    logger.warn('could not inspect the agent rules in the guest.');
    state.rules = 'failed';
    return;
  }
  const isConflict = action === 'conflict';
  if (isConflict) {
    logger.info('The guest has its own agent rules.');
  }
  const ask = isConflict
    ? "Overwrite the guest's agent rules with the sandbox rules?"
    : 'Install/update the sandbox agent rules in the guest?';
  if (!(await confirmDefault(ask, { default: isConflict ? 'n' : 'y', yes: context.options.yes }))) {
    logger.info(
      isConflict
        ? "Keeping the guest's own agent rules."
        : "Keeping the guest's agent rules as they are.",
    );
    state.rules = 'kept';
    return;
  }
  const write = await session.exec(`${node} ${GUEST_AGENT} rules --force`, { input: rendered });
  if (write.code !== 0) {
    logger.warn('could not install the agent rules into the guest.');
    state.rules = 'failed';
    return;
  }
  if (isConflict) {
    state.rules = 'overwritten';
    logger.ok("Overwrote the guest's agent rules.");
  } else {
    state.rules = action === 'install' ? 'installed' : 'updated';
    logger.ok('Installed/updated the sandbox agent rules (opencode + Copilot CLI).');
  }
}
