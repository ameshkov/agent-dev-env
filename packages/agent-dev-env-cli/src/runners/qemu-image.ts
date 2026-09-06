// runners/qemu-image.ts — step 1 for the Windows QEMU backend: pick the
// pristine qcow2 (WINDOWS_IMAGE → local build output → cached pull →
// oras pull with the owner chain — the same precedence as the VMware
// backends' pickImage), then create the working VM state: a COW overlay
// over the pristine image (identity-marker gated so a rebuild over the
// same path drops the stale overlay), the persistent TPM state dir and
// the EFI NVRAM store (seeded from the build output's efivars.fd or the
// Homebrew edk2 template). Port of run-windows-qemu-sandbox.sh
// §step 1/2 (pick_image + ensure_working_vm).

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandExists, run } from '../lib/exec.js';
import { registryRef, resolveOwner } from '../lib/ghcr.js';
import { logger } from '../lib/logger.js';
import { buildDir } from '../lib/paths.js';
import { confirmDefault } from '../lib/prompt.js';
import {
  clearCloneRecord,
  recordClone,
  resolveRegistryDigest,
  writeImageRecord,
} from '../lib/provenance.js';
import {
  backingIdentity,
  QEMU_EFI_VARS_TEMPLATE,
  qemuBackingMarker,
  qemuEfivarsPath,
  qemuImagePath,
  qemuOverlayPath,
  qemuTpmDir,
  qemuWorkingDir,
} from '../lib/qemu.js';
import type { RunContext, RunState } from './framework.js';

/** The env var holding a local qcow2 override (the legacy WINDOWS_IMAGE). */
const IMAGE_OVERRIDE_ENV = 'WINDOWS_IMAGE';

/** Step 1: select the pristine qcow2 and create the working VM state.
 *
 * @param context - The run context.
 * @param state - The accumulated run state (imageArchive = disk path).
 */
export async function ensureQemuImage(context: RunContext, state: RunState): Promise<void> {
  const disk = await pickQemuImage(context);
  state.imageArchive = disk;
  logger.ok(`Using image: ${disk}`);
  await ensureWorkingVm(context, disk);
}

/** The shell's pick_image: WINDOWS_IMAGE → local build output → cached
 *  pull → oras pull (confirm + owner chain).
 *
 * @param context - The run context.
 * @returns The qcow2 path to run.
 */
async function pickQemuImage(context: RunContext): Promise<string> {
  const env = context.options.env;
  const image = context.image;
  const override = env[IMAGE_OVERRIDE_ENV];
  if (override) {
    if (!existsSync(override)) {
      logger.die(`${IMAGE_OVERRIDE_ENV} points to a file that does not exist: ${override}`);
    }
    return override;
  }
  const local = join(buildDir('windows-qemu'), 'output', `${image}.qcow2`);
  if (existsSync(local)) {
    return local;
  }
  const cached = qemuImagePath(image);
  if (existsSync(cached)) {
    return cached;
  }
  return pullQemuImage(context, cached);
}

/** The oras pull into the image/ cache dir (owner chain + confirm +
 *  disk presence check).
 *
 * @param context - The run context.
 * @param cached - The destination qcow2 path.
 * @returns The pulled qcow2 path.
 */
async function pullQemuImage(context: RunContext, cached: string): Promise<string> {
  if (!commandExists('oras')) {
    logger.die(
      'oras is not installed — needed to pull the image (brew install oras). ' +
        `Set ${IMAGE_OVERRIDE_ENV} to a local qcow2 to skip.`,
    );
  }
  const owner = await resolveOwner({ owner: context.options.owner, env: context.options.env });
  const ref = registryRef(context.image, 'latest', owner);
  if (
    !(await confirmDefault(`Pull ${ref} (one-time, ~14 GB download)?`, {
      default: 'y',
      yes: context.options.yes,
    }))
  ) {
    logger.die(
      `aborted — no sandbox image available. Set ${IMAGE_OVERRIDE_ENV} to a local qcow2 or pull manually.`,
    );
  }
  mkdirSync(dirname(cached), { recursive: true });
  logger.info(`Pulling ${ref} (one-time, ~14 GB download)...`);
  const res = await run('oras', ['pull', ref], { cwd: dirname(cached) });
  if (res.code !== 0) {
    logger.die(
      'oras pull failed — check your network connection (public GHCR images pull without a login).',
    );
  }
  if (!existsSync(cached)) {
    logger.die(`oras pull produced no ${cached} — is the image published under ${ref}?`);
  }
  const digest = await resolveRegistryDigest(ref);
  writeImageRecord({
    platform: 'windows-qemu',
    image: context.image,
    registryRef: ref,
    digest,
  });
  return cached;
}

/** Creates the working VM state on first use: a COW overlay over the
 *  pristine image, a persistent EFI NVRAM store and a TPM state dir. The
 *  overlay records its backing image; when the backing image changes (a
 *  rebuild replaces the file at the same path), the overlay is recreated
 *  — otherwise Windows would read a corrupt disk.
 *
 * @param context - The run context.
 * @param pristinePath - The pristine qcow2 path.
 */
async function ensureWorkingVm(context: RunContext, pristinePath: string): Promise<void> {
  const image = context.image;
  const instance = context.instance;
  const overlay = qemuOverlayPath(image, instance);
  const stat = statSync(pristinePath);
  const id = backingIdentity(pristinePath, stat.size, stat.mtimeMs);

  if (backingChanged(image, instance, id)) {
    logger.warn('The backing image changed (new build or pull) — recreating the working VM.');
    logger.warn(
      'Discarding the old overlay, EFI NVRAM, and TPM state (they belong to the previous image).',
    );
    dropWorkingVmState(image, instance);
  }
  if (existsSync(overlay) && readMarker(image, instance) === id) {
    recordClone({
      platform: 'windows-qemu',
      image,
      instance,
      vm: overlay,
      type: 'qcow2',
      name: pristinePath,
      baseIdentity: id,
      backfilled: true,
      clonedAt: new Date(statSync(overlay).mtimeMs).toISOString(),
    });
    logger.ok(`Working VM exists (${overlay}).`);
    return;
  }

  await createOverlay(image, instance, pristinePath, overlay, id);
  await seedEfivars(image, instance, pristinePath);
  logger.ok(`Working VM created (${overlay}).`);
}

/** Whether the recorded backing identity differs from the current disk's
 *  (a rebuild replaces the file at the same path — path alone would
 *  silently stack the old overlay on a different base, a corrupt disk).
 */
function backingChanged(image: string, instance: string, id: string): boolean {
  const markerPath = qemuBackingMarker(image, instance);
  if (!existsSync(markerPath)) {
    return false;
  }
  return readFileSync(markerPath, 'utf8').trim() !== id;
}

/** The recorded backing identity ('' when the marker is missing). */
function readMarker(image: string, instance: string): string {
  const markerPath = qemuBackingMarker(image, instance);
  return existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '';
}

/** Removes the overlay + EFI NVRAM + TPM state that belong to the previous
 *  backing image (the clone record goes with them).
 */
function dropWorkingVmState(image: string, instance: string): void {
  rmSync(qemuWorkingDir(image, instance), { recursive: true, force: true });
  clearCloneRecord('windows-qemu', image, instance);
}

/** Creates the COW overlay over the pristine disk (qemu-img create) and
 *  records both the backing identity and the clone provenance it was
 *  created from.
 */
async function createOverlay(
  image: string,
  instance: string,
  pristinePath: string,
  overlay: string,
  id: string,
): Promise<void> {
  mkdirSync(dirname(overlay), { recursive: true });
  mkdirSync(qemuTpmDir(image, instance), { recursive: true });
  logger.cmd(`qemu-img create -f qcow2 -F qcow2 -b ${pristinePath} ${overlay}`);
  const create = await run('qemu-img', [
    'create',
    '-f',
    'qcow2',
    '-F',
    'qcow2',
    '-b',
    pristinePath,
    overlay,
  ]);
  if (create.code !== 0) {
    logger.die(`qemu-img create failed:\n${create.stderr.trim()}`);
  }
  writeFileSync(qemuBackingMarker(image, instance), id);
  recordClone({
    platform: 'windows-qemu',
    image,
    instance,
    vm: overlay,
    type: 'qcow2',
    name: pristinePath,
    baseIdentity: id,
  });
}

/** Seeds the EFI NVRAM store: the vars file the image was built with (it
 *  holds Windows' own Boot0000 for exactly this install) when the build
 *  output ships one, otherwise the edk2 template (a fresh NVRAM has no
 *  Boot0000 and relies on the \EFI\BOOT\bootaa64.efi fallback the
 *  installer writes).
 */
async function seedEfivars(image: string, instance: string, pristinePath: string): Promise<void> {
  const efivars = qemuEfivarsPath(image, instance);
  if (existsSync(efivars)) {
    return;
  }
  mkdirSync(dirname(efivars), { recursive: true });
  const seeded = join(dirname(pristinePath), 'efivars.fd');
  if (existsSync(seeded)) {
    await run('cp', [seeded, efivars]);
    logger.info('EFI NVRAM: seeded from the build output\u2019s efivars.fd.');
    return;
  }
  if (!existsSync(QEMU_EFI_VARS_TEMPLATE)) {
    logger.die(
      `EFI NVRAM template not found at ${QEMU_EFI_VARS_TEMPLATE} — is Homebrew's qemu installed?`,
    );
  }
  await run('cp', [QEMU_EFI_VARS_TEMPLATE, efivars]);
}
