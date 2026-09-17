// deploy.ts — `agent-dev-env deploy`: pushes built images to GHCR (the
// port of scripts/deploy.sh + the three platform deploy wrappers).
// macOS images go via tart push; the VMware/Ubuntu tar.gz and the QEMU
// qcow2 are split into fixed-size chunks and pushed via oras as OCI
// artifacts with one layer per chunk (a single 22 GiB layer dies when
// GHCR's signed download URL expires mid-transfer; a 512 MiB chunk
// always fits the window). The GHCR owner is resolved GHCR_OWNER →
// --owner → git remote → ameshkov.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RunOptions } from '../lib/exec.js';
import { findRepoRoot } from '../lib/git.js';
import { registryRef, resolveOwner } from '../lib/ghcr.js';
import { logger } from '../lib/logger.js';
import {
  PART_MEDIA_TYPE,
  PART_SIZE_BYTES,
  QCOW2_ARTIFACT_TYPE,
  VMWARE_ARTIFACT_TYPE,
  partsAreCurrent,
  readPartsRecord,
  splitFileToParts,
  type PartsRecord,
} from '../lib/parts.js';
import { runCheckedWithRetries, type RetryOptions } from '../lib/retry.js';
import { ensureVmwareArchiveParts, partsDirOf } from '../lib/vmware-archive.js';
import { buildDirLayout, duHuman, requireCmd } from './build-shared.js';
import { type CatalogImage, imageVersion, resolveRequestedImages } from './catalog.js';

/** Push attempts. Blobs are content-addressed, so a retried push resumes
 *  the transfer instead of restarting it. */
const PUSH_ATTEMPTS = 3;
const PUSH_RETRY_DELAY_MS = 5_000;
const PUSH_RETRY_MAX_DELAY_MS = 60_000;

/** @internal — pushes an image artifact with bounded retries (an
 *  interrupted push is rethrown at once, never retried). Exported for
 *  the co-located tests: a real tart/oras push is out of a unit test's
 *  reach, so the tests exercise the retry wiring with a stub command.
 *
 * @param label - The push description used in the retry warnings.
 * @param cmd - The command (`tart` or `oras`).
 * @param args - Its argv.
 * @param options - run() overrides (cwd/stream).
 * @param retry - Attempt/delay overrides (tests pass zero delays).
 */
export async function pushWithRetries(
  label: string,
  cmd: string,
  args: string[],
  options: RunOptions = {},
  retry: RetryOptions = {},
): Promise<void> {
  await runCheckedWithRetries(cmd, args, options, {
    label,
    attempts: PUSH_ATTEMPTS,
    delayMs: PUSH_RETRY_DELAY_MS,
    maxDelayMs: PUSH_RETRY_MAX_DELAY_MS,
    ...retry,
  });
}

/** The deploy command options. */
export interface DeployOptions {
  /** GHCR owner override (GHCR_OWNER wins over this). */
  owner?: string;
}

/** `agent-dev-env deploy [image...] [--owner OWNER]`.
 *
 * @param requested - Image names (all images when empty).
 * @param options - Owner override.
 * @returns The exit code (0 on success).
 */
export async function deployCmd(
  requested: string[] = [],
  options: DeployOptions = {},
): Promise<number> {
  const repoRoot = findRepoRoot();
  const owner = await resolveOwner({ owner: options.owner, repoRoot: repoRoot ?? undefined });
  const targets = resolveRequestedImages(requested);
  if (requested.length === 0) {
    logger.title('Deploying all images:');
    for (const image of targets) {
      logger.info(image.name);
    }
  }
  for (const image of targets) {
    await deployImage(image, owner);
  }
  return 0;
}

/** Deploys one image with its platform's flow.
 *
 * @param image - The catalog image.
 * @param owner - The resolved GHCR owner.
 */
async function deployImage(image: CatalogImage, owner: string): Promise<void> {
  switch (image.platform) {
    case 'macos':
      await deployMacos(image, owner);
      return;
    case 'windows-qemu':
      await deployQemu(image, owner);
      return;
    case 'windows-vmware':
    case 'ubuntu-vmware':
      await deployVmware(image, owner);
      return;
  }
}

/** macOS: `tart push <image> --chunk-size 3 <ref>:<ver> <ref>:latest`.
 *
 * @param image - The catalog image.
 * @param owner - The GHCR owner.
 */
async function deployMacos(image: CatalogImage, owner: string): Promise<void> {
  requireCmd('tart', 'brew install cirruslabs/tap/tart');
  const version = imageVersion(image);
  const ref = registryRef(image.name, version, owner);
  logger.title(`Pushing image: ${image.name}`);
  logger.info(`Registry: ${ref} and :latest`);
  await pushWithRetries(
    `tart push ${image.name}`,
    'tart',
    tartPushArgs(image.name, ref, registryRef(image.name, 'latest', owner)),
    { stream: true },
  );
  logger.ok(`Done: ${ref} (and :latest)`);
}

/** @internal — the tart push argv (3 MB chunks — GHCR rejects > 4 MB
 *  chunks; test-only export).
 *
 * @param imageName - The local VM image name.
 * @param versionRef - The version registry ref.
 * @param latestRef - The latest registry ref.
 * @returns The tart argv.
 */
export function tartPushArgs(imageName: string, versionRef: string, latestRef: string): string[] {
  return ['push', imageName, '--chunk-size', '3', versionRef, latestRef];
}

/** windows-qemu: split the built qcow2 and oras push one layer per
 *  chunk. The chunks are deleted after a successful push (the qcow2 in
 *  the build output stays the source of truth); after a failed push they
 *  are reused instead of re-split.
 *
 * @param image - The catalog image.
 * @param owner - The GHCR owner.
 */
async function deployQemu(image: CatalogImage, owner: string): Promise<void> {
  const dirs = buildDirLayout('windows-qemu');
  const artifact = join(dirs.output, `${image.name}.qcow2`);
  if (!existsSync(artifact)) {
    throw new Error(
      `no built image at ${artifact}\n       Build it first: agent-dev-env build ${image.name}`,
    );
  }
  requireCmd('oras', 'brew install oras');
  const partsDir = partsDirOf(dirs.output);
  let record = partsAreCurrent([artifact], partsDir) ? readPartsRecord(partsDir) : undefined;
  if (!record) {
    logger.step(`splitting ${artifact} into ${PART_SIZE_BYTES / (1024 * 1024)} MiB chunks`);
    record = await splitFileToParts(artifact, partsDir, {
      kind: 'qcow2',
      artifactType: QCOW2_ARTIFACT_TYPE,
    });
  }
  const version = imageVersion(image);
  const ref = `${registryRef(image.name, version, owner)},latest`;
  logger.title(`Pushing image: ${image.name}`);
  logger.info(`Registry: ${registryRef(image.name, version, owner)} and :latest`);
  logger.info(`Artifact: ${artifact} in ${record.parts.length} chunks`);
  await pushWithRetries(
    `oras push ${image.name} (${record.parts.length} chunks)`,
    'oras',
    orasPushPartsArgs(ref, QCOW2_ARTIFACT_TYPE, record),
    { cwd: partsDir, stream: true },
  );
  rmSync(partsDir, { recursive: true, force: true });
  logger.ok(`Done: ${registryRef(image.name, version, owner)} (and :latest)`);
}

/** @internal — the oras push argv for a chunked image (one layer per
 *  part, in order; the bare names are resolved against the cwd — oras
 *  rejects absolute paths and stores each file under the name it is
 *  given; test-only export).
 *
 * @param ref - The `registry:version,latest` ref.
 * @param artifactType - The OCI artifact media type.
 * @param record - The parts record to push.
 * @returns The oras argv.
 */
export function orasPushPartsArgs(
  ref: string,
  artifactType: string,
  record: PartsRecord,
): string[] {
  return [
    'push',
    '--artifact-type',
    artifactType,
    '--concurrency',
    '5',
    ref,
    ...record.parts.map((part) => `${part.name}:${PART_MEDIA_TYPE}`),
  ];
}

/** windows-vmware / ubuntu-vmware: pack the build output into chunks
 *  (reusing a current chunk set — a redeploy after a failed push skips
 *  the 22 GiB repack), then oras push.
 *
 * @param image - The catalog image.
 * @param owner - The GHCR owner.
 */
async function deployVmware(image: CatalogImage, owner: string): Promise<void> {
  const dirs = buildDirLayout(image.platform as 'windows-vmware' | 'ubuntu-vmware');
  const vmx = join(dirs.output, `${image.name}.vmx`);
  if (!existsSync(vmx)) {
    throw new Error(
      `no built image at ${vmx}\n       Build it first: agent-dev-env build ${image.name}`,
    );
  }
  requireCmd('oras', 'brew install oras');
  const record = await ensureVmwareArchiveParts(dirs.output, image.name);
  const partsDir = partsDirOf(dirs.output);
  const version = imageVersion(image);
  const ref = `${registryRef(image.name, version, owner)},latest`;
  logger.title(`Pushing image: ${image.name}`);
  logger.info(`Registry: ${registryRef(image.name, version, owner)} and :latest`);
  logger.info(
    `Artifact: ${record.parts.length} chunks (${await duHuman(partsDir)}; ${PART_SIZE_BYTES / (1024 * 1024)} MiB each)`,
  );
  await pushWithRetries(
    `oras push ${image.name} (${record.parts.length} chunks)`,
    'oras',
    orasPushPartsArgs(ref, VMWARE_ARTIFACT_TYPE, record),
    { cwd: partsDir, stream: true },
  );
  logger.ok(`Done: ${registryRef(image.name, version, owner)} (and :latest)`);
}
