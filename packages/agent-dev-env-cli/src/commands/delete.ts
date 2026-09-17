// commands/delete.ts — `agent-dev-env delete <platform> [--yes]
// [--pristine]`: stop the sandbox (delegating to the same flow as
// `stop`), then remove the VM/state. macOS: `tart delete` the working VM
// (+ the pristine image with --pristine). VMware (Ubuntu + Windows) and
// QEMU (Windows): `rm -rf` the instance's state dir; `--pristine` also
// drops the shared pristine cache (the pulled image + the extracted
// base) when no other instance remains — with one, the cache is kept
// (its working state may depend on it, and re-cloning needs it), and
// without the flag the cache follows the last-instance rule. The next
// run re-pulls and re-clones.

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
 *  pristine cache (image/ + base/) follows the --pristine /
 *  last-instance policy (applyPristinePolicy).
 *
 * @param platform - The VMware platform to delete.
 * @param options - --yes / --pristine flags.
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
  const state = await deleteInstanceState(
    platform,
    runOptions,
    instanceStateDir,
    (size) =>
      `Delete the sandbox instance state at '${instanceStateDir}' (${size})? ` +
      `This removes the working clone of '${runOptions.image}' (instance '${runOptions.instance}').`,
    yes,
  );
  const pristineRemoved = await applyPristinePolicy(
    platform,
    runOptions.image,
    runOptions.instance,
    state,
    options.pristine === true,
  );
  if (state === 'removed') {
    logger.warn(
      "Fusion's VM library may still list the deleted working VM — remove the stale entry in the Fusion UI (harmless).",
    );
  }

  logger.step('Sandbox deleted');
  logger.info(`State: ${instanceStateDir}`);
  logger.info(pristineSummary(platform, runOptions.image, pristineRemoved));
  logger.info(`Next run: agent-dev-env run ${platform} (re-clones the instance)`);
}

/** The QEMU delete flow — stop first (delegating to the stop flow), then
 *  remove the instance's state (working disk overlay + TPM + EFI NVRAM).
 *  The shared pristine qcow2 cache follows the --pristine /
 *  last-instance policy (applyPristinePolicy).
 *
 * @param options - --yes / --pristine flags.
 */
async function deleteQemu(options: DeleteOptions): Promise<void> {
  const runOptions = resolveRunOptions('windows-qemu', { yes: options.yes });
  const instanceStateDir = qemuWorkingDir(runOptions.image, runOptions.instance);
  const yes = options.yes === true;

  logger.title(`Deleting Windows QEMU sandbox: ${runOptions.image} (${runOptions.instance})`);

  logger.step('Stopping the sandbox');
  await stopQemuSandbox();

  logger.step('Deleting the state');
  const state = await deleteInstanceState(
    'windows-qemu',
    runOptions,
    instanceStateDir,
    (size) =>
      `Delete the sandbox instance state at '${instanceStateDir}' (${size})? ` +
      `This removes the working overlay + TPM + EFI NVRAM of '${runOptions.image}' ` +
      `(instance '${runOptions.instance}').`,
    yes,
  );
  const pristineRemoved = await applyPristinePolicy(
    'windows-qemu',
    runOptions.image,
    runOptions.instance,
    state,
    options.pristine === true,
  );

  logger.step('Sandbox deleted');
  logger.info(`State: ${instanceStateDir}`);
  logger.info(pristineSummary('windows-qemu', runOptions.image, pristineRemoved));
  logger.info('Next run: agent-dev-env run windows-qemu (re-clones the instance)');
}

/** The outcome of the instance-state step: the dir was removed, did not
 *  exist, or its deletion was declined (kept). */
type InstanceStateResult = 'removed' | 'absent' | 'kept';

/** Deletes one instance's state dir after confirmation and clears its
 *  clone record — shared by the VMware and QEMU flows.
 *
 * @internal — test-only export; the delete flows call it in this module.
 * @param platform - The platform (clone-record cleanup).
 * @param options - The resolved image + instance.
 * @param dir - The instance state dir.
 * @param ask - Builds the confirmation question from the dir size.
 * @param yes - --yes flag.
 * @returns Whether the state was removed, absent, or kept.
 */
export async function deleteInstanceState(
  platform: Platform,
  options: { image: string; instance: string },
  dir: string,
  ask: (size: string) => string,
  yes: boolean,
): Promise<InstanceStateResult> {
  if (!existsSync(dir)) {
    logger.info(`No state at ${dir} (already deleted?) — nothing to delete.`);
    return 'absent';
  }
  const size = await dirSizeHuman(dir);
  if (!(yes || (await confirm(ask(size), { default: 'y' })))) {
    logger.info(`Kept '${dir}' — nothing was deleted.`);
    return 'kept';
  }
  logger.cmd(`rm -rf ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  clearCloneRecord(platform, options.image, options.instance);
  logger.ok(`Instance state deleted: ${dir} (${size} freed).`);
  return 'removed';
}

/** Applies the pristine-cache policy after the instance-state step:
 *  --pristine drops the shared cache when no other instance remains —
 *  with one it is kept (a working disk may depend on it, and re-cloning
 *  needs it) and the user is warned; without the flag the cache follows
 *  the last-instance rule. A declined instance-state deletion keeps the
 *  cache too.
 *
 * @internal — test-only export; the delete flows call it in this module.
 * @param platform - The platform.
 * @param image - The image name.
 * @param instance - The deleted instance.
 * @param state - The instance-state outcome.
 * @param pristine - The --pristine flag.
 * @returns True when the pristine cache was removed.
 */
export async function applyPristinePolicy(
  platform: Platform,
  image: string,
  instance: string,
  state: InstanceStateResult,
  pristine: boolean,
): Promise<boolean> {
  if (state === 'kept') {
    if (pristine) {
      logger.info('Kept the pristine image cache too — the instance state was kept.');
    }
    return false;
  }
  const remaining = listInstances(platform, image).filter((name) => name !== instance);
  if (pristine) {
    if (remaining.length > 0) {
      logger.warn(
        `Other instances remain (${remaining.join(', ')}) — keeping the shared pristine image ` +
          'cache; delete them first to remove it.',
      );
      return false;
    }
    await dropPristine(platform, image);
    return true;
  }
  if (state !== 'removed') {
    return false;
  }
  if (remaining.length > 0) {
    logger.info(
      `Other instances remain (${remaining.join(', ')}) — keeping the shared pristine image.`,
    );
    return false;
  }
  await dropPristine(platform, image);
  return true;
}

/** Removes the pristine image root (the pulled image + extracted base +
 *  provenance record); callers ensure no instance state remains first.
 *
 * @param platform - The platform.
 * @param image - The image name.
 */
async function dropPristine(platform: Platform, image: string): Promise<void> {
  const root = imageRootDir(platform, image);
  if (!existsSync(root)) {
    logger.info(`No pristine image cache at ${root} — nothing to delete.`);
    return;
  }
  const size = await dirSizeHuman(root);
  logger.cmd(`rm -rf ${root}`);
  rmSync(root, { recursive: true, force: true });
  clearImageRecord(platform, image);
  logger.ok(`Shared pristine image removed: ${root} (${size} freed).`);
}

/** The post-delete summary line about the pristine cache — the bare
 *  "Sandbox deleted" used to imply the cache went with it.
 *
 * @param platform - The platform.
 * @param image - The image name.
 * @param removed - Whether applyPristinePolicy removed the cache.
 * @returns The summary line.
 */
function pristineSummary(platform: Platform, image: string, removed: boolean): string {
  return removed
    ? 'Pristine image cache: removed.'
    : `Pristine image cache: kept at ${imageRootDir(platform, image)}.`;
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
