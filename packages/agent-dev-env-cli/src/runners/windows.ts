// runners/windows.ts — the Windows 11 (ARM64) VMware backend (Phase 5 of
// the port): vmrun-driven image/base/clone (windows-image.ts), boot with
// the guest-IP + sshd waits and the one-time auto-logon
// (windows-autologon.ts), the HGFS-share step (windows-shared.ts — skipped
// for ARM guests), the NAT-segment bridges + guest agent over the
// PowerShell transport (windows-bridges.ts / windows-guest.ts), the user
// settings copy (settings/windows-copy.ts) and the summary. Port of
// run-windows-vmware-sandbox.sh §steps 0-6.

import { rmSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import { instanceDir } from '../lib/paths.js';
import { openSshSession, waitForSshd } from '../lib/ssh.js';
import { startVm } from '../lib/vmrun.js';
import { ensureUserSettings, restartOpenchamber } from '../settings/windows-copy.js';
import type { RunContext, RunState, SandboxBackend } from './framework.js';
import { ensureBridgeDir } from './bridges.js';
import { offerOpenInBrowser, waitForOpenchamber } from './openchamber.js';
import { ensureAutologon } from './windows-autologon.js';
import { windowsBridges } from './windows-bridges.js';
import { resolveGuestCredentials } from './windows-guest.js';
import { ensureWindowsImage, windowsWorkingVmx } from './windows-image.js';
import { offerGuestReboot } from './windows-reboot.js';
import { setupWindowsSharedFolder } from './windows-shared.js';
import { printWindowsSummary } from './windows-summary.js';
import {
  cleanupRunBridge,
  requireVmrun,
  stopRunningVm,
  waitForForegroundVmStop,
  waitGuestIp,
} from './vmware-common.js';

const PLATFORM = 'windows-vmware' as const;

/** The Windows VMware backend — vmrun + ssh2 (PowerShell in the guest;
 *  the state lives under the CLI's data dir).
 */
export const windowsBackend: SandboxBackend = {
  preflight: (context) => preflight(context),
  ensureImageAndVm: (context, state) => ensureWindowsImage(context, state),
  boot: boot,
  setupBridges: (context, state) => windowsBridges(context, state),
  setupSettings: (context, state) => setupSettings(context, state),
  verifyOpenchamber: (context, state) => verifyOpenchamber(context, state),
  summarize: (context, state) => printWindowsSummary(context, state),
  finish: finish,
};

async function preflight(context: RunContext): Promise<void> {
  requireVmrun();
  ensureBridgeDir();
  if (context.options.reset) {
    const root = instanceDir(PLATFORM, context.image, context.instance);
    logger.info(
      `Resetting the working VM (--reset) — deleting the working instance '${context.instance}'.`,
    );
    rmSync(root, { recursive: true, force: true });
  }
}

// --- step 2: boot -----------------------------------------------------------

async function boot(context: RunContext, state: RunState): Promise<void> {
  const workVmx = windowsWorkingVmx(context.image, context.instance);
  await stopRunningVm(context, workVmx, PLATFORM);
  logger.cmd(`vmrun -T fusion start ${workVmx} ${context.options.headless ? 'nogui' : 'gui'}`);
  const start = await startVm(workVmx, context.options.headless ? 'nogui' : 'gui');
  if (start.code !== 0) {
    throw new Error(`vmrun start failed:\n${start.stderr.trim()}`);
  }
  logger.ok('VM started.');
  state.vmIp = await waitGuestIp(workVmx);
  logger.ok(`Guest IP: ${state.vmIp}`);

  const creds = resolveGuestCredentials(context.image, context.options.env, state.vmIp);
  process.stdout.write('    Waiting for the guest to boot (up to 10 min)');
  if (await waitForSshd(creds)) {
    process.stdout.write(` ${logger.color('green')}done${logger.reset()}\n`);
    logger.ok(`VM is up: ssh ${creds.username}@${state.vmIp}`);
  } else {
    process.stdout.write(` ${logger.color('yellow')}failed${logger.reset()}\n`);
    logger.die(`timed out waiting for the guest to boot (no SSH on ${state.vmIp}:22).`);
  }
  await ensureAutologon(context, state, workVmx, creds);
  await setupWindowsSharedFolder(context, state, workVmx);
}

// --- step 4/5 hooks ---------------------------------------------------------

async function setupSettings(context: RunContext, state: RunState): Promise<void> {
  if (context.options.noSettings) {
    logger.info('Skipping user settings copy (--no-settings).');
    state.settings = 'skipped';
    return;
  }
  if (!state.vmIp) {
    logger.warn('no guest IP — skipping the user settings copy.');
    state.settings = 'failed';
    return;
  }
  const creds = resolveGuestCredentials(context.image, context.options.env, state.vmIp);
  const session = await openSshSession(creds);
  try {
    const outcome = await ensureUserSettings(
      session,
      context.options.home,
      context.options.yes,
      creds.username,
    );
    state.settings = outcome.state;
    if (outcome.state === 'copied') {
      await restartOpenchamber(session);
      if (outcome.envApplied) {
        const workVmx = windowsWorkingVmx(context.image, context.instance);
        const rebooted = await offerGuestReboot(session, context.options.yes, creds, async () => {
          const ip = await waitGuestIp(workVmx);
          return resolveGuestCredentials(context.image, context.options.env, ip);
        });
        if (rebooted) {
          state.vmIp = rebooted.host;
        }
      }
    }
  } catch (err) {
    state.settings = 'failed';
    logger.warn(`settings copy failed: ${(err as Error).message}`);
  } finally {
    session.end();
  }
}

async function verifyOpenchamber(context: RunContext, state: RunState): Promise<void> {
  if (!state.vmIp) {
    logger.warn('OpenChamber: guest IP unavailable — cannot probe.');
    return;
  }
  state.openchamberUrl = `http://${state.vmIp}:${context.openchamberPort}`;
  state.openchamberUp = await waitForOpenchamber(state.openchamberUrl);
  if (state.openchamberUp) {
    await offerOpenInBrowser(state.openchamberUrl, context.options.yes);
  }
}

// --- finish: foreground wait + bridge cleanup --------------------------------

async function finish(context: RunContext, state: RunState): Promise<void> {
  if (!context.options.foreground) {
    return;
  }
  await waitForForegroundVmStop(windowsWorkingVmx(context.image, context.instance));
  // The VM stopped (or Cmd+C was pressed) — kill the bridges this run
  // started; in background mode they stay up, outliving the CLI by design.
  await cleanupRunBridge(state.bridges.agent.pid, 'agent bridge');
  await cleanupRunBridge(state.bridges.docker.pid, 'Docker bridge');
}
