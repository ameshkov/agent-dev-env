// commands/sync.ts — `agent-dev-env sync <platform> [--yes]`: copy the
// host's user settings into the guest on demand (no VM restart), update
// the version marker and restart OpenChamber. macOS lands in Phase 3
// (tart transport), Ubuntu in Phase 4 and both Windows backends in the
// same ssh2 transport (psExec + SFTP for the Windows guests).

import { existsSync } from 'node:fs';
import { sleep } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { workingVmxPath } from '../lib/paths.js';
import { isQemuAlive } from '../lib/qemu.js';
import type { Platform } from '../lib/platform.js';
import { openSshSession, type SshCredentials } from '../lib/ssh.js';
import { tartAvailable, vmExists, vmState } from '../lib/tart.js';
import { findVmrun, getGuestIpAddress, isVmRunning } from '../lib/vmrun.js';
import { syncUserSettings } from '../settings/macos-copy.js';
import { syncUserSettings as syncUbuntuSettings } from '../settings/ubuntu-copy.js';
import { syncUserSettings as syncWindowsSettings } from '../settings/windows-copy.js';
import { resolveGuestCredentials as resolveUbuntuCredentials } from '../runners/ubuntu-guest.js';
import { resolveGuestCredentials as resolveWindowsCredentials } from '../runners/windows-guest.js';
import { resolveRunOptions } from '../runners/options.js';

export interface SyncOptions {
  yes?: boolean;
}

/** Syncs the host's user settings into the guest.
 *
 * @param platform - The platform to sync.
 * @param options - --yes flag.
 * @returns The process exit code.
 */
export async function syncCmd(platform: Platform, options: SyncOptions): Promise<number> {
  if (platform === 'macos') {
    await syncMacos(options);
    return 0;
  }
  if (platform === 'ubuntu-vmware') {
    await syncUbuntu(options);
    return 0;
  }
  if (platform === 'windows-vmware') {
    await syncWindowsVmware(options);
    return 0;
  }
  await syncWindowsQemu(options);
  return 0;
}

/** The macOS sync flow (VM must be running — `tart exec` needs it). */
async function syncMacos(options: SyncOptions): Promise<void> {
  if (!tartAvailable()) {
    logger.die("tart is not installed — run 'brew install cirruslabs/cli/tart' first.");
  }
  const runOptions = resolveRunOptions('macos', { yes: options.yes });
  const { instance } = runOptions;

  logger.title(`Syncing user settings into ${instance}`);
  if (!(await vmExists(instance))) {
    logger.die(`working VM '${instance}' not found — run 'agent-dev-env run macos' first.`);
  }
  if ((await vmState(instance)) !== 'running') {
    logger.die(`VM '${instance}' is not running — start it with 'agent-dev-env run macos' first.`);
  }

  const outcome = await syncUserSettings(
    instance,
    runOptions.home,
    runOptions.yes === true,
    runOptions.openchamberPort,
  );
  if (outcome === 'copied') {
    logger.ok(`Done — settings synced into '${instance}'.`);
  }
}

/** The Ubuntu sync flow (VM must be running + sshd up — the settings
 *  travel over the ssh2 session).
 */
async function syncUbuntu(options: SyncOptions): Promise<void> {
  if (!findVmrun()) {
    logger.die(
      'vmrun not found — install VMware Fusion (free for personal use) or set FUSION_APP_PATH.',
    );
  }
  const runOptions = resolveRunOptions('ubuntu-vmware', { yes: options.yes });
  const vmx = workingVmxPath('ubuntu-vmware', runOptions.image, runOptions.instance);

  logger.title(`Syncing user settings into ${vmx}`);
  if (!existsSync(vmx)) {
    logger.die(`working VM '${vmx}' not found — run 'agent-dev-env run ubuntu-vmware' first.`);
  }
  if (!(await isVmRunning(vmx))) {
    logger.die(
      `VM '${vmx}' is not running — start it with 'agent-dev-env run ubuntu-vmware' first.`,
    );
  }

  const ip = await waitGuestIp(vmx);
  const creds = resolveUbuntuCredentials(runOptions.image, runOptions.env, ip);
  const session = await openSshSession(creds);
  try {
    const outcome = await syncUbuntuSettings(
      session,
      runOptions.home,
      runOptions.yes === true,
      creds.password,
    );
    if (outcome === 'copied') {
      logger.ok(`Done — settings synced into '${vmx}'.`);
    }
  } finally {
    session.end();
  }
}

/** The Windows VMware sync flow (VM must be running + sshd up — the
 *  settings travel over the ssh2 session, like the run step).
 */
async function syncWindowsVmware(options: SyncOptions): Promise<void> {
  if (!findVmrun()) {
    logger.die(
      'vmrun not found — install VMware Fusion (free for personal use) or set FUSION_APP_PATH.',
    );
  }
  const runOptions = resolveRunOptions('windows-vmware', { yes: options.yes });
  const vmx = workingVmxPath('windows-vmware', runOptions.image, runOptions.instance);

  logger.title(`Syncing user settings into ${vmx}`);
  if (!existsSync(vmx)) {
    logger.die(`working VM '${vmx}' not found — run 'agent-dev-env run windows-vmware' first.`);
  }
  if (!(await isVmRunning(vmx))) {
    logger.die(
      `VM '${vmx}' is not running — start it with 'agent-dev-env run windows-vmware' first.`,
    );
  }

  const ip = await waitGuestIp(vmx);
  const creds = resolveWindowsCredentials(runOptions.image, runOptions.env, ip);
  await syncOverSsh(creds, runOptions, vmx);
}

/** The Windows QEMU sync flow (qemu must be running — the settings travel
 *  through the hostfwd forward on 127.0.0.1).
 */
async function syncWindowsQemu(options: SyncOptions): Promise<void> {
  const runOptions = resolveRunOptions('windows-qemu', { yes: options.yes });
  const { instance } = runOptions;

  logger.title(`Syncing user settings into ${instance}`);
  if (!isQemuAlive(runOptions.image, instance)) {
    logger.die(
      `VM '${instance}' is not running — start it with 'agent-dev-env run windows-qemu' first.`,
    );
  }

  const creds = resolveWindowsCredentials(
    runOptions.image,
    runOptions.env,
    '127.0.0.1',
    runOptions.sshPort,
  );
  await syncOverSsh(creds, runOptions, instance);
}

/** The shared ssh2 sync flow: copy always (no marker gate) + restart
 *  OpenChamber, then close the session.
 *
 * @param creds - The guest credentials.
 * @param runOptions - The resolved run options (home, yes).
 * @param target - The display name of the VM being synced into.
 */
async function syncOverSsh(
  creds: SshCredentials,
  runOptions: ReturnType<typeof resolveRunOptions>,
  target: string,
): Promise<void> {
  const session = await openSshSession(creds);
  try {
    const outcome = await syncWindowsSettings(
      session,
      runOptions.home,
      runOptions.yes === true,
      creds.username,
    );
    if (outcome === 'copied') {
      logger.ok(`Done — settings synced into '${target}'.`);
    }
  } finally {
    session.end();
  }
}

/** Waits for the guest IP (bounded per call; the sync cannot proceed
 *  without it).
 *
 * @param vmx - The working VM vmx.
 * @returns The guest IP.
 */
async function waitGuestIp(vmx: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ip = await getGuestIpAddress(vmx);
    if (ip) {
      return ip;
    }
    await sleep(2000);
  }
  return logger.die('timed out waiting for the guest IP — are open-vm-tools running in the guest?');
}
