// runners/windows-qemu.ts — the Windows 11 (ARM64) QEMU backend (Phase 6
// of the port): qemu-system-aarch64 drives the qcow2 disk with swtpm
// (lib/qemu.ts: overlay + TPM + EFI NVRAM + the exact launch_qemu args),
// the guest is reached through the hostfwd forwards on 127.0.0.1, the
// one-time auto-logon (windows-autologon.ts) so OpenChamber fires at
// boot, the hostfwd bridges + the same guest agent wiring over ssh2
// (windows-bridges.ts / windows-guest.ts), the user settings copy
// (settings/windows-copy.ts) and the summary. Port of
// run-windows-qemu-sandbox.sh §steps 0-5.

import { rmSync } from 'node:fs';
import { isAlive, sleep } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { confirmDefault } from '../lib/prompt.js';
import {
  buildQemuArgs,
  isQemuAlive,
  launchQemu,
  QEMU_EFI_CODE,
  qemuEfivarsPath,
  qemuOverlayPath,
  qemuWorkingDir,
  requireQemu,
  startSwtpm,
  stopQemu,
  stopSwtpm,
  swtpmSockPath,
} from '../lib/qemu.js';
import { openSshSession, probeSshd, type SshCredentials } from '../lib/ssh.js';
import { ensureUserSettings, restartOpenchamber } from '../settings/windows-copy.js';
import type { RunContext, RunState, SandboxBackend } from './framework.js';
import { ensureBridgeDir } from './bridges.js';
import { offerOpenInBrowser, waitForOpenchamber } from './openchamber.js';
import { ensureQemuImage } from './qemu-image.js';
import { cleanupRunBridge } from './vmware-common.js';
import { windowsBridges } from './windows-bridges.js';
import { configureAutologon } from './windows-autologon.js';
import { resolveGuestCredentials } from './windows-guest.js';
import { printQemuSummary } from './windows-qemu-summary.js';
import { offerGuestReboot, waitForGuestReboot } from './windows-reboot.js';

const PLATFORM = 'windows-qemu' as const;

/** The QEMU Windows backend — qemu-system-aarch64 + swtpm + ssh2 (the
 *  state lives under the CLI's data dir, like the VMware backends).
 */
export const windowsQemuBackend: SandboxBackend = {
  preflight: (context) => preflight(context),
  ensureImageAndVm: (context, state) => ensureQemuImage(context, state),
  boot: boot,
  setupBridges: (context, state) => windowsBridges(context, state),
  setupSettings: (context, state) => setupSettings(context, state),
  verifyOpenchamber: (context, state) => verifyOpenchamber(context, state),
  summarize: (context, state) => printQemuSummary(context, state),
  finish: finish,
};

async function preflight(context: RunContext): Promise<void> {
  requireQemu();
  ensureBridgeDir();
  if (context.options.reset) {
    const root = qemuWorkingDir(context.image, context.instance);
    logger.info(
      `Resetting the working VM (--reset) — deleting the overlay, TPM state, and EFI NVRAM of instance '${context.instance}'.`,
    );
    rmSync(root, { recursive: true, force: true });
  }
}

// --- step 2: boot -----------------------------------------------------------

async function boot(context: RunContext, state: RunState): Promise<void> {
  await stopRunningQemu(context);
  await startSwtpm(context.image, context.instance);
  const args = buildQemuArgs({
    efiCode: QEMU_EFI_CODE,
    efivars: qemuEfivarsPath(context.image, context.instance),
    overlay: qemuOverlayPath(context.image, context.instance),
    tpmSock: swtpmSockPath(context.image, context.instance),
    sshPort: context.sshPort,
    rdpPort: context.rdpPort,
    openchamberPort: context.openchamberPort,
    winrmPort: context.winrmPort,
    cpuCount: context.cpuCount,
    memoryMb: context.memoryMb,
    headless: context.options.headless,
  });
  state.qemuPid = await launchQemu(context.image, context.instance, args);
  const creds = resolveGuestCredentials(
    context.image,
    context.options.env,
    '127.0.0.1',
    context.sshPort,
  );
  await waitForQemuBoot(creds, state.qemuPid);
  await ensureQemuAutologon(context, creds);
}

/** Stops a qemu left running by a previous (detached) run — the old qemu
 *  holds the overlay and its swtpm holds the TPM state lock. The legacy
 *  stop_running_vm: restart confirm defaults to no (checked via the
 *  pidfile, since a previous run's qemu predates this run's state).
 */
async function stopRunningQemu(context: RunContext): Promise<void> {
  const { image, instance } = context;
  if (!isQemuAlive(image, instance)) {
    return;
  }
  if (
    !(await confirmDefault('The sandbox VM is already running — restart it?', {
      default: 'n',
      yes: context.options.yes,
    }))
  ) {
    logger.die(`aborted — the VM is already running. Stop it with: agent-dev-env stop ${PLATFORM}`);
  }
  await stopQemu(image, instance);
  await sleep(1000);
}

/** The sshd wait with the qemu-alive check (the legacy wait_for_sshd:
 *  the hostfwd listener binds the moment qemu starts, before the guest
 *  even boots — probe for a real sshd instead of the port).
 */
async function waitForQemuBoot(creds: SshCredentials, qemuPid: number): Promise<void> {
  process.stdout.write('    Waiting for the VM to boot (up to 10 min)');
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (!isAlive(qemuPid)) {
      process.stdout.write(` ${logger.color('yellow')}failed${logger.reset()}\n`);
      logger.die(`qemu exited before the VM booted — check the qemu log.`);
    }
    if ((await probeSshd(creds)) === 'up') {
      process.stdout.write(` ${logger.color('green')}done${logger.reset()}\n`);
      logger.ok(`VM is up: ssh ${creds.username}@127.0.0.1:${creds.port}`);
      return;
    }
    if (attempt < 149) {
      await sleep(4000);
    }
  }
  process.stdout.write(` ${logger.color('yellow')}failed${logger.reset()}\n`);
  logger.die(`timed out waiting for the VM to boot (no SSH on 127.0.0.1:${creds.port}).`);
}

/** The QEMU auto-logon: configure, then wait through the shared
 *  down-then-up reboot wait on the fixed hostfwd target — unlike the
 *  VMware flow, no guest-IP refresh is needed.
 */
async function ensureQemuAutologon(context: RunContext, creds: SshCredentials): Promise<void> {
  if (!(await configureAutologon(context, creds))) {
    return;
  }
  logger.info('Rebooting the guest (a minute or two)...');
  await waitForGuestReboot(creds, async () => creds, 'Guest rebooted with auto-logon enabled.');
}

// --- step 4/5 hooks ---------------------------------------------------------

async function setupSettings(context: RunContext, state: RunState): Promise<void> {
  if (context.options.noSettings) {
    logger.info('Skipping user settings copy (--no-settings).');
    state.settings = 'skipped';
    return;
  }
  const creds = resolveGuestCredentials(
    context.image,
    context.options.env,
    '127.0.0.1',
    context.sshPort,
  );
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
        await offerGuestReboot(session, context.options.yes, creds, async () => creds);
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
  state.openchamberUrl = `http://127.0.0.1:${context.openchamberPort}`;
  state.openchamberUp = await waitForOpenchamber(state.openchamberUrl);
  if (state.openchamberUp) {
    await offerOpenInBrowser(state.openchamberUrl, context.options.yes);
  }
}

// --- finish: foreground wait + bridge/swtpm cleanup --------------------------

async function finish(context: RunContext, state: RunState): Promise<void> {
  if (!context.options.foreground) {
    return;
  }
  await waitForQemuStop(state.qemuPid ?? -1);
  // The VM stopped (or Cmd+C was pressed) — kill the bridges this run
  // started and swtpm (it holds the TPM state lock); in background mode
  // they stay up, outliving the CLI by design.
  await cleanupRunBridge(state.bridges.agent.pid, 'agent bridge');
  await cleanupRunBridge(state.bridges.docker.pid, 'Docker bridge');
  await stopSwtpm(context.image, context.instance);
}

/** The foreground wait: poll qemu until it exits; a Cmd+C stops it
 *  through a SIGTERM (the shell's EXIT trap killed qemu with the script
 *  group; we own the detached child, so kill it explicitly).
 */
async function waitForQemuStop(qemuPid: number): Promise<void> {
  if (!isAlive(qemuPid)) {
    logger.info('VM is not running.');
    return;
  }
  let stopping = false;
  const onSignal = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('Stopping the VM (Cmd+C)...');
    try {
      process.kill(qemuPid, 'SIGTERM');
    } catch {
      // already gone
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  logger.info('Waiting for the VM to stop (Cmd+C to stop it now)...');
  try {
    while (isAlive(qemuPid)) {
      await sleep(3000);
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  logger.info('VM stopped.');
}
