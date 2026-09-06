// runners/macos-summary.ts — the "Sandbox is ready" block (port of the
// shell's print_summary, same labels, same wording, same color scheme).
// The lines are printed with the label column right-aligned to 12 chars
// and the value padded to 4 spaces — like `printf '    %-12s %s\n'`.

import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import { cloneSourceLine } from '../lib/provenance.js';
import { vmIp, vmState } from '../lib/tart.js';
import type { RunContext, RunState } from './framework.js';

/** Prints the macOS summary block (VM/shared dir/keys/bridges/rules/
 *  settings/OpenChamber/stop hints).
 *
 * @param context - The run context.
 * @param state - The accumulated run state.
 */
export async function printMacosSummary(context: RunContext, state: RunState): Promise<void> {
  const ip = await vmIp(context.instance);
  const vmStateNow = (await vmState(context.instance)) ?? 'stopped';

  logger.step('Sandbox is ready');
  const ipDesc = ip ? `IP ${ip}` : 'IP unavailable';
  summaryLine('VM', `${logger.bold(context.instance)} (${vmStateNow}, ${ipDesc})`);
  summaryLine('Image source', cloneSourceLine('macos', context.image, context.instance));
  if (context.workDir && existsSync(context.workDir)) {
    summaryLine('Shared dir', `${context.workDir} (in the guest: ${context.guestMount})`);
  } else {
    summaryLine('Shared dir', 'not shared');
  }
  if (state.mode === 'gui') {
    summaryLine('Keys', 'system shortcuts go to the guest while the window is focused');
  }
  printBridgeLines(context, state);
  printRulesLine(state.rules);
  printSettingsLine(state.settings);
  printOpenchamberLine(context, state, ip);
  printStopLines(context, state);
}

/** One `    LABEL........  VALUE` line. */
function summaryLine(label: string, value: string): void {
  logger.out(`    ${label.padEnd(12)}${value}`);
}

function printBridgeLines(context: RunContext, state: RunState): void {
  const agent = state.bridges.agent;
  if (agent.bridged) {
    const value = agent.guestUp
      ? `host agent -> TCP ${context.agentPort} -> guest (/tmp/ssh-agent.sock)`
      : `host bridge up (TCP ${context.agentPort}), guest bridge not running`;
    summaryLine('SSH agent', agent.guestUp ? loggerOk(value) : loggerWarn(value));
  } else {
    summaryLine('SSH agent', 'not bridged');
  }
  const docker = state.bridges.docker;
  if (docker.bridged) {
    if (docker.engineUp) {
      summaryLine(
        'Docker',
        loggerOk(
          `host engine (v${docker.serverVersion}) -> TCP ${context.dockerPort} -> guest (context 'host')`,
        ),
      );
    } else if (docker.guestUp) {
      summaryLine(
        'Docker',
        loggerWarn('bridge up, engine not reachable in the guest — is Docker running on the host?'),
      );
    } else {
      summaryLine(
        'Docker',
        loggerWarn(`host bridge up (TCP ${context.dockerPort}), guest bridge not running`),
      );
    }
  } else {
    summaryLine('Docker', 'not bridged');
  }
}

function printRulesLine(rules: RunState['rules']): void {
  switch (rules) {
    case 'installed':
      summaryLine('Agent rules', loggerOk('installed for opencode + Copilot'));
      break;
    case 'updated':
    case 'overwritten':
      summaryLine('Agent rules', loggerOk('updated for opencode + Copilot'));
      break;
    case 'uptodate':
      summaryLine('Agent rules', 'up to date in the guest');
      break;
    case 'kept':
      summaryLine('Agent rules', 'guest rules kept (not overwritten)');
      break;
    case 'failed':
      summaryLine('Agent rules', loggerWarn('could not be installed'));
      break;
    default:
      summaryLine('Agent rules', 'not installed');
  }
}

function printSettingsLine(settings: RunState['settings']): void {
  switch (settings) {
    case 'copied':
      summaryLine('Settings', loggerOk('copied into the guest'));
      break;
    case 'uptodate':
      summaryLine('Settings', 'already in the guest');
      break;
    case 'skipped':
      summaryLine('Settings', 'not copied (--no-settings)');
      break;
    case 'none':
      summaryLine('Settings', 'nothing to copy on the host');
      break;
    case 'failed':
      summaryLine('Settings', loggerWarn('copy failed — re-run `agent-dev-env run` to retry'));
      break;
    default:
      summaryLine('Settings', 'not copied');
  }
}

function printOpenchamberLine(context: RunContext, state: RunState, ip: string | undefined): void {
  if (state.openchamberUp && state.openchamberUrl) {
    summaryLine('OpenChamber', loggerOk(`${state.openchamberUrl} (password: sandbox)`));
  } else if (ip) {
    summaryLine(
      'OpenChamber',
      loggerWarn(`not responding on http://${ip}:${context.openchamberPort}`),
    );
  } else {
    summaryLine('OpenChamber', loggerWarn('not responding (VM IP unavailable)'));
  }
}

function printStopLines(context: RunContext, state: RunState): void {
  let hint = 'run "agent-dev-env stop macos"';
  if (context.options.foreground && context.options.headless) {
    hint = 'run "agent-dev-env stop macos" in another terminal';
  } else if (context.options.foreground && state.tartPid !== undefined) {
    hint = 'press Cmd+C in this terminal, or run "agent-dev-env stop macos" in another terminal';
  }
  summaryLine('Stop', hint);
  if (!context.options.foreground && state.tartPid !== undefined) {
    summaryLine(
      'Background',
      `VM keeps running after this script exits (tart log: ${state.tartLog})`,
    );
    if (state.bridges.agent.bridged) {
      summaryLine(
        'Bridge',
        `host listener on TCP ${context.agentPort} stays up — stop it with: agent-dev-env stop macos`,
      );
    }
    if (state.bridges.docker.bridged) {
      summaryLine(
        'Bridge',
        `host Docker listener on TCP ${context.dockerPort} stays up — stop it with: agent-dev-env stop macos`,
      );
    }
  }
}

// color helpers — the shell's ${c_green}/${c_yellow} inline.
function loggerOk(text: string): string {
  return logger.color('green') + text + logger.reset();
}

function loggerWarn(text: string): string {
  return logger.color('yellow') + text + logger.reset();
}
