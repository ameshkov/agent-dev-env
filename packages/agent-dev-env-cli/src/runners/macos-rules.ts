// runners/macos-rules.ts — the agent-rules step: render the bundled rules
// for this run and drive the guest agent's `rules --probe` / `rules
// --force` (the sha256 marker semantics live in the guest agent). Port
// of the shell's install_agent_rules (probe → confirm → overwrite, with
// the conflict default of no).

import { execVm } from '../lib/tart.js';
import { logger } from '../lib/logger.js';
import { confirmDefault } from '../lib/prompt.js';
import type { RunContext, RunState } from './framework.js';
import { GUEST_AGENT } from './macos-guest.js';
import {
  loadAgentRules,
  loadHostGlobalAgents,
  mergeAgentRules,
  renderAgentRules,
} from './rules.js';

/** The agent-rules probe/confirm/apply.
 *
 * @param context - The run context (paths to substitute).
 * @param state - The accumulated run state (bridge flags).
 * @param node - The guest's node binary.
 */
export async function installAgentRules(
  context: RunContext,
  state: RunState,
  node: string,
): Promise<void> {
  const content = loadAgentRules();
  if (!content) {
    logger.warn('agent rules file not found (assets/rules/agent-rules.md).');
    state.rules = 'failed';
    return;
  }
  const rendered = renderAgentRules(
    content,
    { HOST_WORK_DIR: context.workDir, GUEST_MOUNT: context.guestMount },
    state.bridges.agent.bridged && state.bridges.agent.guestUp,
  );
  const merged = mergeAgentRules(loadHostGlobalAgents(), rendered);

  const probe = await execVm(context.instance, [node, GUEST_AGENT, 'rules'], { input: merged });
  const action = /^rules:probe=(.+)$/.exec(probe.stdout.trim())?.[1];
  if (probe.code !== 0 || !action) {
    logger.warn('could not inspect the agent rules in the guest.');
    state.rules = 'failed';
    return;
  }
  await applyRulesAction(context, state, node, merged, action);
}

/** The probe outcome decision tree (shell parity: install/update ask
 *  with the y default, conflict asks with the n default). */
async function applyRulesAction(
  context: RunContext,
  state: RunState,
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
  const write = await execVm(context.instance, [node, GUEST_AGENT, 'rules', '--force'], {
    input: rendered,
  });
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
