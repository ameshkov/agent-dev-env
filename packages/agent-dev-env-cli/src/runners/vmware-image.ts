// runners/vmware-image.ts — step 1b for the VMware backends (ubuntu-vmware
// and windows-vmware, Phase 4 + Phase 5): clone the pristine base extracted
// by vmware-image-archive.ts into the working VM + set its display name,
// and upgrade it once per hardware version (.hw-version). Port of
// run-{ubuntu,windows}-vmware-sandbox.sh §step 2; the CLI's data dir
// replaces the legacy one. The per-platform pieces (platform id) are
// parameters, so the two VMware backends share one implementation.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../lib/logger.js';
import { workingVmxPath } from '../lib/paths.js';
import type { Platform } from '../lib/platform.js';
import { recordClone } from '../lib/provenance.js';
import { cloneVm, setVmDisplayName, upgradeVmHardware, vmwareHwVersion } from '../lib/vmrun.js';
import { archiveIdentity, baseVmx, ensureVmwareArchive } from './vmware-image-archive.js';
import type { RunContext, RunState } from './framework.js';

/** The working clone's vmx. */
export function vmwareWorkingVmx(platform: Platform, image: string, instance: string): string {
  return workingVmxPath(platform, image, instance);
}

/** The .hw-version marker (records the upgraded hardware version). */
function hwMarker(platform: Platform, image: string, instance: string): string {
  return join(dirname(vmwareWorkingVmx(platform, image, instance)), '.hw-version');
}

/** Step 1: select the archive + extract the base (vmware-image-archive.ts),
 *  clone the working VM and upgrade it if the installed Fusion supports a
 *  newer hardware version.
 *
 * @param platform - The target platform (state dir naming).
 * @param overrideEnv - The env var holding a local archive override
 *   (UBUNTU_VMWARE_IMAGE / WINDOWS_VMWARE_IMAGE).
 * @param context - The run context.
 * @param state - The accumulated run state (imageArchive set here).
 */
export async function ensureVmwareImage(
  platform: Platform,
  overrideEnv: string,
  context: RunContext,
  state: RunState,
): Promise<void> {
  const archive = await ensureVmwareArchive(platform, overrideEnv, context);
  state.imageArchive = archive;
  logger.ok(`Using archive: ${archive}`);
  if (!(await ensureWorkingVm(platform, context, archive))) {
    logger.die(
      'could not clone the working VM (see above). Check Fusion\u2019s VM library path and re-run.',
    );
  }
  await upgradeWorkingVm(platform, context);
}

/** Clones the pristine base into the working VM or reuses an existing
 *  clone (backfilling the clone provenance either way).
 *
 * @param platform - The target platform.
 * @param context - The run context.
 * @param archive - The archive the pristine base was extracted from.
 * @returns True when the clone exists.
 */
async function ensureWorkingVm(
  platform: Platform,
  context: RunContext,
  archive: string,
): Promise<boolean> {
  const image = context.image;
  const instance = context.instance;
  const wVmx = vmwareWorkingVmx(platform, image, instance);
  if (existsSync(wVmx)) {
    recordClone({
      platform,
      image,
      instance,
      vm: wVmx,
      type: 'vmx',
      name: archive,
      backfilled: true,
      clonedAt: new Date(statSync(wVmx).mtimeMs).toISOString(),
    });
    logger.ok(`Working VM exists (${wVmx}).`);
    return true;
  }
  if (!(await cloneWorkingVm(platform, image, wVmx))) {
    return false;
  }
  return finishWorkingClone(platform, context, archive, wVmx);
}

/** `vmrun clone <base> <working> full` with the real error surfaced
 *  (the generic "Fusion rejected the path" warning used to hide it).
 *
 * @param platform - The target platform.
 * @param image - The image name.
 * @param wVmx - The working vmx destination.
 * @returns True when the clone succeeded.
 */
async function cloneWorkingVm(platform: Platform, image: string, wVmx: string): Promise<boolean> {
  mkdirSync(dirname(wVmx), { recursive: true });
  logger.cmd(`vmrun -T fusion clone ${baseVmx(platform, image)} ${wVmx} full`);
  const res = await cloneVm(baseVmx(platform, image), wVmx);
  if (res.code !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim()).split('\n').pop();
    logger.warn(
      detail
        ? `full clone failed: ${detail} (Fusion may have rejected the destination path).`
        : 'full clone failed (Fusion may have rejected the destination path).',
    );
    return false;
  }
  return true;
}

/** Sets the working VM's display name (clone inherits the base's — the
 *  working VM would show under the base's name in Fusion's library
 *  otherwise) and records the clone provenance.
 *
 * @param platform - The target platform.
 * @param context - The run context.
 * @param archive - The archive the pristine base was extracted from.
 * @param wVmx - The working vmx.
 * @returns True (the clone is usable regardless of the display name).
 */
function finishWorkingClone(
  platform: Platform,
  context: RunContext,
  archive: string,
  wVmx: string,
): boolean {
  logger.cmd(`set displayName "${context.instance}" in ${wVmx}`);
  if (!setVmDisplayName(wVmx, context.instance)) {
    logger.warn(
      'could not set the working VM\u2019s display name (Fusion will show the base\u2019s name).',
    );
  }
  const id = archiveIdentity(archive, statSync(archive).size, statSync(archive).mtimeMs);
  recordClone({
    platform,
    image: context.image,
    instance: context.instance,
    vm: wVmx,
    type: 'vmx',
    name: archive,
    baseIdentity: id,
  });
  logger.ok(`Working VM cloned (${wVmx}; display name '${context.instance}').`);
  return true;
}

/** Upgrades the working clone once per hardware version (vmrun
 *  upgradevm — the no-op hang is why it runs only when the marker
 *  differs).
 *
 * @param platform - The target platform.
 * @param context - The run context.
 */
async function upgradeWorkingVm(platform: Platform, context: RunContext): Promise<void> {
  const wVmx = vmwareWorkingVmx(platform, context.image, context.instance);
  const before = vmwareHwVersion(wVmx);
  if (!before) {
    return;
  }
  const markerPath = hwMarker(platform, context.image, context.instance);
  const marker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '';
  if (marker === before) {
    return;
  }
  const after = await upgradeVmHardware(wVmx);
  if (!after) {
    logger.warn(
      'could not upgrade the working VM (vmrun missing?) — the first GUI start may prompt.',
    );
    return;
  }
  writeFileSync(markerPath, after);
  if (after !== before) {
    logger.ok(
      `Working VM upgraded to hardware version ${after} (the installed Fusion\u2019s current).`,
    );
  }
}
