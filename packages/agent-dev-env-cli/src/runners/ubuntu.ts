// runners/ubuntu.ts — the Ubuntu 24.04 (ARM64) VMware backend (Phase 4 of
// the port): vmrun-driven image/base/clone (ubuntu-image.ts), boot with
// the guest-IP + sshd waits and the HGFS share (ubuntu-shared.ts), the
// NAT-segment bridges + guest agent over ssh2 (ubuntu-bridges.ts), the
// settings copy over ssh2 (settings/ubuntu-copy.ts) and the summary.
// Port of run-ubuntu-vmware-sandbox.sh §steps 0-8.

import { rmSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import { instanceDir } from '../lib/paths.js';
import { openSshSession, waitForSshd } from '../lib/ssh.js';
import { startVm } from '../lib/vmrun.js';
import { ensureUserSettings, restartOpenchamber } from '../settings/ubuntu-copy.js';
import type { RunContext, RunState, SandboxBackend } from './framework.js';
import { ensureBridgeDir } from './bridges.js';
import { offerOpenInBrowser, waitForOpenchamber } from './openchamber.js';
import { ensureUbuntuImage, ubuntuWorkingVmx } from './ubuntu-image.js';
import { ubuntuBridges } from './ubuntu-bridges.js';
import { resolveGuestCredentials } from './ubuntu-guest.js';
import { setupSharedFolder } from './ubuntu-shared.js';
import { printUbuntuSummary } from './ubuntu-summary.js';
import {
  cleanupRunBridge,
  requireVmrun,
  stopRunningVm,
  waitForForegroundVmStop,
  waitGuestIp,
} from './vmware-common.js';

const PLATFORM = 'ubuntu-vmware' as const;

/** The Ubuntu backend — vmrun + ssh2 (no Tart; the state lives under the
 *  CLI's data dir, unlike the macOS backend's no-footprint design).
 */
export const ubuntuBackend: SandboxBackend = {
  preflight: (context) => preflight(context),
  ensureImageAndVm: (context, state) => ensureUbuntuImage(context, state),
  boot: boot,
  setupBridges: (context, state) => ubuntuBridges(context, state),
  setupSettings: (context, state) => setupSettings(context, state),
  verifyOpenchamber: (context, state) => verifyOpenchamber(context, state),
  summarize: (context, state) => printUbuntuSummary(context, state),
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
  const workVmx = ubuntuWorkingVmx(context.image, context.instance);
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
  await setupSharedFolder(context, workVmx, creds);
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
    state.settings = await ensureUserSettings(
      session,
      context.options.home,
      context.options.yes,
      creds.password,
    );
    if (state.settings === 'copied') {
      await restartOpenchamber(session);
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
  await waitForForegroundVmStop(ubuntuWorkingVmx(context.image, context.instance));
  // The VM stopped (or Cmd+C was pressed) — kill the bridges this run
  // started; in background mode they stay up, outliving the CLI by design.
  await cleanupRunBridge(state.bridges.agent.pid, 'agent bridge');
  await cleanupRunBridge(state.bridges.docker.pid, 'Docker bridge');
}
