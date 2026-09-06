// runners/macos-provenance.ts — the macOS backend's provenance helpers:
// recording the clone source when a fresh clone happens, backfilling the
// record for a pre-existing working VM (cloned before provenance
// tracking), and recording the image pull. Split out of macos.ts to keep
// the runner within the file-size limit and the provenance concerns in
// one module.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { registryRef, resolveOwner } from '../lib/ghcr.js';
import { recordClone, resolveRegistryDigest, writeImageRecord } from '../lib/provenance.js';
import type { RunContext } from './framework.js';

/** The macOS platform id (provenance records). */
const PLATFORM = 'macos' as const;
/** The tart store's config.json for a VM (under the given home).
 * @internal - test-only export; production callers go through
 * backfillMacosClone, which passes context.options.home itself.
 * @param vm - The tart VM name.
 * @param home - The host home dir.
 * @returns The config path.
 */
export function tartVmConfigPath(vm: string, home: string): string {
  return join(home, '.tart', 'vms', vm, 'config.json');
}

/** The recorded clone-time approximation: the config.json mtime (rewritten
 *  by `tart set` at first boot, shortly after the clone), or undefined
 *  when the store is missing it.
 * @internal - test-only export (pure helper); production callers go
 * through backfillMacosClone.
 * @param configPath - The config.json path.
 * @returns The ISO time, or undefined.
 */
export function cloneTimeFromConfig(configPath: string): string | undefined {
  return existsSync(configPath) ? new Date(statSync(configPath).mtimeMs).toISOString() : undefined;
}
/** Records the clone provenance right after a fresh clone: the working VM
 *  is always `tart clone` of the pristine image; the registry ref/digest
 *  are the ones the image was (or would be) pulled under.
 *
 * @param context - The run context.
 */
export async function recordMacosClone(context: RunContext): Promise<void> {
  const owner = await resolveOwner({ owner: context.options.owner, env: context.options.env });
  const ref = registryRef(context.image, 'latest', owner);
  const digest = await resolveRegistryDigest(ref);
  recordClone({
    platform: PLATFORM,
    image: context.image,
    instance: context.instance,
    vm: context.instance,
    type: 'tart',
    name: context.image,
    registryRef: ref,
    digest,
  });
}

/** Backfills the clone record for a pre-existing working VM (cloned
 *  before provenance tracking): the tart source is always the pristine
 *  image, so the local facts are known — the registry ref/digest and the
 *  true clone time are not. The clone time is approximated from the VM's
 *  config.json mtime in the tart store.
 *
 * @param context - The run context.
 */
export function backfillMacosClone(context: RunContext): void {
  const clonedAt = cloneTimeFromConfig(tartVmConfigPath(context.instance, context.options.home));
  recordClone({
    platform: PLATFORM,
    image: context.image,
    instance: context.instance,
    vm: context.instance,
    type: 'tart',
    name: context.image,
    backfilled: true,
    ...(clonedAt ? { clonedAt } : {}),
  });
}

/** Records the image pull (ref + best-effort digest) right after the
 *  `tart pull` succeeds.
 *
 * @param context - The run context.
 */
export async function recordMacosImagePull(context: RunContext): Promise<void> {
  const owner = await resolveOwner({ owner: context.options.owner, env: context.options.env });
  const ref = registryRef(context.image, 'latest', owner);
  const digest = await resolveRegistryDigest(ref);
  writeImageRecord({
    platform: PLATFORM,
    image: context.image,
    registryRef: ref,
    digest,
  });
}
