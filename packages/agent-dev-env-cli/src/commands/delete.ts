// commands/delete.ts — `agent-dev-env delete <platform> [--yes]
// [--pristine]`: stop the sandbox (delegating to the same flow as
// `stop`), then remove the VM/state. macOS: `tart delete` the working VM
// (+ the pristine image with --pristine). VMware (Ubuntu + Windows) and
// QEMU (Windows): `rm -rf` the state dir (extracted base + working clone
// or overlay/TPM/NVRAM + pulled cache) — the next run re-pulls and
// re-clones.

import { existsSync, rmSync } from 'node:fs';
import { run } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { imageRootDir, instanceDir, listInstances } from '../lib/paths.js';
import type { Platform } from '../lib/platform.js';
import { qemuWorkingDir } from '../lib/qemu.js';
import { clearCloneRecord, clearImageRecord } from '../lib/provenance.js';
import { deleteVm, stopVm, tartAvailable, vmExists, vmState } from '../lib/tart.js';
import { findVmrun } from '../lib/vmrun.js';
import { confirm } from '../lib/prompt.js';
import { resolveRunOptions } from '../runners/options.js';
import { stopMacos, stopQemuSandbox, stopVmware } from './stop.js';

export interface DeleteOptions {
  yes?: boolean;
  pristine?: boolean;
}

/** Deletes a sandbox platform.
 *
 * @param platform - The platform to delete.
 * @param options - --yes / --pristine flags.
 * @returns The process exit code.
 */
export async function deleteCmd(platform: Platform, options: DeleteOptions): Promise<number> {
  if (platform === 'macos') {
    await deleteMacos(options);
    return 0;
  }
  if (platform === 'windows-qemu') {
    await deleteQemu(options);
    return 0;
  }
  await deleteVmware(platform, options);
  return 0;
}

/** The macOS delete flow (working VM, optionally the pristine image). */
async function deleteMacos(options: DeleteOptions): Promise<void> {
  if (!tartAvailable()) {
    logger.die("tart is not installed — run 'brew install cirruslabs/cli/tart' first.");
  }
  const runOptions = resolveRunOptions('macos', { yes: options.yes });
  const { instance, image } = runOptions;
  const yes = options.yes === true;

  logger.title(`Deleting macOS sandbox: ${instance}`);

  logger.step('Stopping the sandbox');
  await stopMacos();

  logger.step('Deleting the working VM');
  if (await vmExists(instance)) {
    const ask =
      `Delete the working VM '${instance}'? This stops and removes it — the next ` +
      `run re-clones it from '${image}'.`;
    if (yes || (await confirm(ask, { default: 'y' }))) {
      logger.cmd(`tart delete ${instance}`);
      const res = await deleteVm(instance);
      if (res.code !== 0) {
        logger.warn(`'tart delete ${instance}' failed — is it running?`);
        logger.warn(`Kept the '${instance}' state — nothing was deleted.`);
      } else {
        clearCloneRecord('macos', image, instance);
        if (await vmExists(instance)) {
          logger.warn(`VM '${instance}' still exists after 'tart delete'.`);
        }
        logger.ok(`Working VM '${instance}' deleted.`);
      }
    } else {
      logger.info(`Kept '${instance}' — nothing was deleted.`);
    }
  } else {
    clearCloneRecord('macos', image, instance);
    logger.info(`Working VM '${instance}' does not exist (already deleted?) — nothing to delete.`);
  }

  await maybeDeletePristine(image, yes, options.pristine === true);

  logger.step('Sandbox deleted');
  logger.info(
    `Working VM: ${instance} — deleted if it existed (next run re-clones from '${image}').`,
  );
  logger.info('Pristine image: ' + image + ' — kept or deleted per the flags above.');
  logger.info('Next run: agent-dev-env run macos');
}

/** The VMware delete flow — stop first, then remove the instance's
 *  working state (shared by the Ubuntu and Windows backends). The shared
 *  pristine cache (image/ + base/) is dropped only with the last instance
 *  — other instances keep using it.
 *
 * @param platform - The VMware platform to delete.
 * @param options - --yes flag.
 */
async function deleteVmware(platform: Platform, options: DeleteOptions): Promise<void> {
  if (!findVmrun()) {
    logger.die(
      'vmrun not found — install VMware Fusion (free for personal use) or set FUSION_APP_PATH.',
    );
  }
  const runOptions = resolveRunOptions(platform, { yes: options.yes });
  const instanceStateDir = instanceDirFor(platform, runOptions);
  const yes = options.yes === true;
  const label = platform === 'ubuntu-vmware' ? 'Ubuntu' : 'Windows';

  logger.title(`Deleting ${label} VMware sandbox: ${runOptions.image} (${runOptions.instance})`);

  logger.step('Stopping the sandbox');
  await stopVmware(platform);

  logger.step('Deleting the state');
  if (!existsSync(instanceStateDir)) {
    logger.info(`No state at ${instanceStateDir} (already deleted?) — nothing to delete.`);
  } else {
    const size = await dirSizeHuman(instanceStateDir);
    const ask =
      `Delete the sandbox instance state at '${instanceStateDir}' (${size})? ` +
      `This removes the working clone of '${runOptions.image}' (instance '${runOptions.instance}').`;
    if (yes || (await confirm(ask, { default: 'y' }))) {
      logger.cmd(`rm -rf ${instanceStateDir}`);
      rmSync(instanceStateDir, { recursive: true, force: true });
      clearCloneRecord(platform, runOptions.image, runOptions.instance);
      logger.ok(`Instance state deleted: ${instanceStateDir} (${size} freed).`);
      await removePristineIfLast(platform, runOptions.image, runOptions.instance);
      logger.warn(
        "Fusion's VM library may still list the deleted working VM — remove the stale entry in the Fusion UI (harmless).",
      );
    } else {
      logger.info(`Kept '${instanceStateDir}' — nothing was deleted.`);
    }
  }

  logger.step('Sandbox deleted');
  logger.info(`State: ${instanceStateDir}`);
  logger.info(`Next run: agent-dev-env run ${platform} (re-clones the instance)`);
}

/** The QEMU delete flow — stop first (delegating to the stop flow), then
 *  remove the instance's state (working disk overlay + TPM + EFI NVRAM).
 *  The shared pristine qcow2 cache is dropped only with the last instance.
 *
 * @param options - --yes flag.
 */
async function deleteQemu(options: DeleteOptions): Promise<void> {
  const runOptions = resolveRunOptions('windows-qemu', { yes: options.yes });
  const instanceStateDir = qemuWorkingDir(runOptions.image, runOptions.instance);
  const yes = options.yes === true;

  logger.title(`Deleting Windows QEMU sandbox: ${runOptions.image} (${runOptions.instance})`);

  logger.step('Stopping the sandbox');
  await stopQemuSandbox();

  logger.step('Deleting the state');
  if (!existsSync(instanceStateDir)) {
    logger.info(`No state at ${instanceStateDir} (already deleted?) — nothing to delete.`);
  } else {
    const size = await dirSizeHuman(instanceStateDir);
    const ask =
      `Delete the sandbox instance state at '${instanceStateDir}' (${size})? ` +
      `This removes the working overlay + TPM + EFI NVRAM of '${runOptions.image}' ` +
      `(instance '${runOptions.instance}').`;
    if (yes || (await confirm(ask, { default: 'y' }))) {
      logger.cmd(`rm -rf ${instanceStateDir}`);
      rmSync(instanceStateDir, { recursive: true, force: true });
      clearCloneRecord('windows-qemu', runOptions.image, runOptions.instance);
      logger.ok(`Instance state deleted: ${instanceStateDir} (${size} freed).`);
      await removePristineIfLast('windows-qemu', runOptions.image, runOptions.instance);
    } else {
      logger.info(`Kept '${instanceStateDir}' — nothing was deleted.`);
    }
  }

  logger.step('Sandbox deleted');
  logger.info(`State: ${instanceStateDir}`);
  logger.info(`Next run: agent-dev-env run windows-qemu (re-clones the instance)`);
}

/** Removes the shared pristine cache (image/ + base/) when the deleted
 *  instance was the last one — other instances must keep it. Image root
 *  removed in full (instancesDir is per-image; only `working` is shared
 *  with live instances and it is empty at this point).
 */
async function removePristineIfLast(
  platform: Platform,
  image: string,
  instance: string,
): Promise<void> {
  const remaining = listInstances(platform, image).filter((name) => name !== instance);
  if (remaining.length > 0) {
    logger.info(
      `Other instances remain (${remaining.join(', ')}) — keeping the shared pristine image.`,
    );
    return;
  }
  const root = imageRootDir(platform, image);
  const size = await dirSizeHuman(root);
  logger.cmd(`rm -rf ${root}`);
  rmSync(root, { recursive: true, force: true });
  clearImageRecord(platform, image);
  logger.ok(`Shared pristine image removed: ${root} (${size} freed).`);
}

/** The instance state dir for a resolved run (VMware). */
function instanceDirFor(platform: Platform, options: ReturnType<typeof resolveRunOptions>): string {
  return instanceDir(platform, options.image, options.instance);
}

/** @internal — `du -sh`-style human size ("12G", "812M"); '?' on failure. */
export async function dirSizeHuman(dir: string): Promise<string> {
  const res = await run('du', ['-sh', dir]);
  return res.code === 0 ? res.stdout.trim().split('\t')[0] : '?';
}

/** The pristine-image deletion — always opt-in (never implied). */
async function maybeDeletePristine(image: string, yes: boolean, pristine: boolean): Promise<void> {
  const ask =
    `Also delete the pristine image '${image}' (frees ~50 GB; re-pulled from ` +
    'GHCR on the next run)?';
  if (!pristine && !(yes || (await confirm(ask, { default: 'n' })))) {
    logger.info(`Kept the pristine image '${image}'.`);
    return;
  }
  if (!(await vmExists(image))) {
    logger.info(`Pristine image '${image}' does not exist — nothing to delete.`);
    return;
  }
  if ((await vmState(image)) === 'running') {
    logger.cmd(`tart stop ${image}`);
    await stopVm(image);
  }
  logger.cmd(`tart delete ${image}`);
  const res = await deleteVm(image);
  clearImageRecord('macos', image);
  if (res.code === 0) {
    logger.ok(`Pristine image '${image}' deleted.`);
  } else {
    logger.warn(`'tart delete ${image}' failed — is it running?`);
  }
}
