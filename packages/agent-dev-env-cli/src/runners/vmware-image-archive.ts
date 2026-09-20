// runners/vmware-image-archive.ts — step 1a for the VMware backends
// (ubuntu-vmware and windows-vmware, Phase 4 + Phase 5): pick the image
// chunks (env override → local build output → cached pull → chunked
// oras pull) and extract the pristine base/ (identity marker = the chunk
// set's manifest digest / part-digest hash, so a rebuild or a new pull is
// detected). The clone step lives in vmware-image.ts; the chunk layout
// here MUST match the one lib/vmware-archive.ts packs for deploy.
//
// Port of run-{ubuntu,windows}-vmware-sandbox.sh §pick_image + base
// extraction; the CLI's data dir replaces the legacy one. The
// per-platform pieces (platform id, the archive override env var) are
// parameters, so the two VMware backends share one implementation.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandExists, run } from '../lib/exec.js';
import { registryRef, resolveOwner } from '../lib/ghcr.js';
import { logger } from '../lib/logger.js';
import {
  buildDir,
  imageRootDir,
  listInstances,
  vmwareBaseDir,
  vmwarePartsDir,
} from '../lib/paths.js';
import {
  assertPartsComplete,
  createPartsReadStream,
  missingParts,
  partsAreCurrent,
  partsIdentity,
  readPartsRecord,
  splitFileToParts,
  PARTS_RECORD_NAME,
  VMWARE_ARTIFACT_TYPE,
  type PartsRecord,
} from '../lib/parts.js';
import { PLATFORM_DEFAULTS, type Platform } from '../lib/platform.js';
import { confirmDefault, type ConfirmOptions } from '../lib/prompt.js';
import { writeImageRecord } from '../lib/provenance.js';
import { ensureVmwareLocalParts, partsDirOf } from '../lib/vmware-archive.js';
import type { RunContext } from './framework.js';
import { pullImageParts } from './parts-pull.js';

/** The pristine base vmx (the clone source).
 *
 * @param platform - The target platform.
 * @param image - The image name.
 * @returns The base vmx path.
 */
export function baseVmx(platform: Platform, image: string): string {
  return join(vmwareBaseDir(platform, image), `${image}.vmx`);
}

/** The archive identity marker path. */
function baseMarker(platform: Platform, image: string): string {
  return join(imageRootDir(platform, image), 'base-archive.txt');
}

/** @internal — the disk filenames a vmx references (only device nodes
 *  with a backing file: `<controller><#>:<#>.filename` entries). The
 *  rest of the `.filename` properties in a vmx are NOT disks and have
 *  no archive member: the "auto detect" CD-ROM and the empty
 *  serial/parallel/replay entries, the sound placeholder (`-1` when no
 *  sound device is selected) and the runtime-only
 *  `vmxstats.filename` scoreboard — a naive "any .filename" match
 *  flags them as missing disks and fails the pristine-extraction
 *  check.
 *
 * @param content - The vmx text.
 * @returns The referenced disk filenames.
 */
export function vmxDiskFiles(content: string): string[] {
  const files: string[] = [];
  for (const match of content.matchAll(/^[ \t]*\w+\d+:\d+\.filename[ \t]*=[ \t]*"([^"]+)"/gm)) {
    const file = match[1];
    if (file !== '' && file !== 'auto detect' && file !== '-1') {
      files.push(file);
    }
  }
  return files;
}

/** The base-disk files the base vmx references that are missing next to
 *  the vmx — a corrupt extraction parks the disks under the archive's
 *  absolute paths instead of the base root, and the relative vmx refs
 *  then break the vmrun clone.
 *
 * @param baseDirPath - The pristine base dir.
 * @param baseVmxPath - The pristine base vmx.
 * @returns The missing disk file names (empty when the base is complete).
 */
function missingBaseDisks(baseDirPath: string, baseVmxPath: string): string[] {
  const content = existsSync(baseVmxPath) ? readFileSync(baseVmxPath, 'utf8') : '';
  return vmxDiskFiles(content).filter((file) => !existsSync(join(baseDirPath, file)));
}

/** Drops the pristine base and every working instance (used when the
 *  image changed and when the extracted base turns out incomplete).
 *
 * @param platform - The target platform.
 * @param image - The image name.
 */
function dropBaseState(platform: Platform, image: string): void {
  rmSync(vmwareBaseDir(platform, image), { recursive: true, force: true });
  rmSync(join(imageRootDir(platform, image), 'working'), { recursive: true, force: true });
}

/** Step 1a: pick the image chunks and extract the pristine base (the
 *  clone step in vmware-image.ts consumes the returned parts dir).
 *
 * @param platform - The target platform (state dir naming).
 * @param overrideEnv - The env var holding a local image override — a
 *   chunked-image directory or a tar.gz (UBUNTU_VMWARE_IMAGE /
 *   WINDOWS_VMWARE_IMAGE).
 * @param context - The run context.
 * @returns The parts directory the base was extracted from.
 */
export async function ensureVmwareArchive(
  platform: Platform,
  overrideEnv: string,
  context: RunContext,
): Promise<string> {
  const partsDir = await pickImage(platform, overrideEnv, context);
  await ensureBase(platform, context, partsDir);
  return partsDir;
}

/** The shell's pick_image: <OVERRIDE_ENV> → local build output (packed
 *  on demand) → cached chunks → chunked oras pull with the owner chain.
 *
 * @param platform - The target platform.
 * @param overrideEnv - The environment override variable name.
 * @param context - The run context.
 * @returns The parts directory to run from.
 */
async function pickImage(
  platform: Platform,
  overrideEnv: string,
  context: RunContext,
): Promise<string> {
  const env = context.options.env;
  const image = context.image;
  const override = env[overrideEnv];
  if (override) {
    return resolveOverride(override, overrideEnv);
  }
  const outputDir = join(buildDir(platform), 'output');
  if (existsSync(join(outputDir, `${image}.vmx`))) {
    await ensureVmwareLocalParts(outputDir, image);
    return partsDirOf(outputDir);
  }
  const cached = vmwarePartsDir(platform, image);
  const record = readPartsRecord(cached);
  if (record && missingParts(cached, record).length === 0) {
    return cached;
  }
  return pullImage(platform, overrideEnv, context, cached);
}

/** Resolves a local image override: a directory in the parts layout
 *  (part-NNNN files + parts.json) is used as-is; a local tar.gz (the
 *  documented golden-image workflow) is split once into a sibling
 *  `<archive>.parts` directory and re-split when the tarball changes.
 *
 * @param override - The configured path.
 * @param overrideEnv - The env var name (for error messages).
 * @returns The validated parts directory.
 */
async function resolveOverride(override: string, overrideEnv: string): Promise<string> {
  if (!existsSync(override)) {
    throw new Error(`${overrideEnv} points to a path that does not exist: ${override}`);
  }
  if (statSync(override).isFile()) {
    return splitOverrideArchive(override);
  }
  const record = readPartsRecord(override);
  if (!record) {
    throw new Error(
      `${overrideEnv} must point to a chunked image directory (part-NNNN files + ${PARTS_RECORD_NAME}) or a local tar.gz: ${override}`,
    );
  }
  assertPartsComplete(override, record);
  return override;
}

/** Splits a local tar.gz override into its cached sibling parts
 *  directory (one-time per archive version). */
async function splitOverrideArchive(archive: string): Promise<string> {
  const partsDir = `${archive}.parts`;
  if (!partsAreCurrent([archive], partsDir)) {
    logger.info(`Splitting the local image archive ${archive} into chunks (one-time per archive).`);
    await splitFileToParts(archive, partsDir, {
      kind: 'tar.gz',
      artifactType: VMWARE_ARTIFACT_TYPE,
    });
  }
  return partsDir;
}

/** The chunked oras pull into the image/ cache dir (owner chain +
 *  confirm + completeness check), then the provenance record.
 *
 * @param platform - The target platform.
 * @param overrideEnv - The environment override variable name (prompts).
 * @param context - The run context.
 * @param partsDir - The destination parts directory.
 * @returns The pulled parts directory.
 */
async function pullImage(
  platform: Platform,
  overrideEnv: string,
  context: RunContext,
  partsDir: string,
): Promise<string> {
  if (!commandExists('oras')) {
    logger.die(
      'oras is not installed — needed to pull the image (brew install oras). ' +
        `Set ${overrideEnv} to a local chunked image directory to skip.`,
    );
  }
  const owner = await resolveOwner({ owner: context.options.owner, env: context.options.env });
  const ref = registryRef(context.image, 'latest', owner);
  const hint = PLATFORM_DEFAULTS[platform].downloadHint;
  if (
    !(await confirmDefault(`Pull ${ref} (one-time, ${hint} download)?`, {
      default: 'y',
      yes: context.options.yes,
    }))
  ) {
    logger.die(
      `aborted — no sandbox image available. Set ${overrideEnv} to a local chunked image directory or pull manually.`,
    );
  }
  mkdirSync(partsDir, { recursive: true });
  logger.info(`Pulling ${ref} (one-time, ${hint} download in 512 MiB chunks)...`);
  const record = await pullChunked(ref, partsDir);
  writeImageRecord({
    platform,
    image: context.image,
    registryRef: ref,
    digest: record.manifestDigest ?? undefined,
  });
  removeLegacyCache(platform, context.image);
  return partsDir;
}

/** The chunked pull with the retry hint (a killed pull keeps the chunks
 *  it already completed). */
async function pullChunked(ref: string, partsDir: string): Promise<PartsRecord> {
  try {
    return await pullImageParts({ ref, partsDir });
  } catch (err) {
    throw new Error(
      `image pull failed: ${(err as Error).message}\n       Re-run the command to retry — downloaded chunks are kept.`,
      { cause: err },
    );
  }
}

/** Removes the pre-chunking single-file cache after a successful chunked
 *  pull (it is superseded and would otherwise waste a full image's
 *  worth of disk). */
function removeLegacyCache(platform: Platform, image: string): void {
  const legacy = join(imageRootDir(platform, image), 'image', `${image}.tar.gz`);
  if (!existsSync(legacy)) {
    return;
  }
  logger.warn(`Removing the legacy single-file image cache ${legacy} (superseded by the chunks).`);
  rmSync(legacy, { force: true });
}

/** The parts record of a parts directory (must exist by the time the
 *  base is extracted).
 *
 * @param partsDir - The parts directory.
 * @returns The record.
 * @throws Error when the record is missing or unreadable.
 */
function requirePartsRecord(partsDir: string): PartsRecord {
  const record = readPartsRecord(partsDir);
  if (!record) {
    throw new Error(
      `no chunked image record at ${join(partsDir, PARTS_RECORD_NAME)} — re-run to pull the image`,
    );
  }
  return record;
}

/** The chunk-set identity recorded with the working clone (the
 *  baseIdentity in clone.json; see lib/provenance.ts).
 *
 * @param partsDir - The parts directory.
 * @returns The identity string.
 */
export function archivePartsIdentity(partsDir: string): string {
  return partsIdentity(requirePartsRecord(partsDir));
}

/** @internal — whether a changed image should be re-extracted
 *  (test-only export; ensureBase calls it within this module). When
 *  working instances exist the user is asked (default no — declining
 *  keeps the previous base + instances, so the run continues on the old
 *  image); with none, nothing is lost, so there is nothing to ask.
 *
 * @param context - The run context (--yes flag).
 * @param platform - The target platform.
 * @param image - The image name.
 * @param streams - Injectable confirm streams (tests).
 * @returns True to drop the base + working instances and re-extract.
 */
export async function shouldReextract(
  context: RunContext,
  platform: Platform,
  image: string,
  streams: Pick<ConfirmOptions, 'input' | 'output'> = {},
): Promise<boolean> {
  if (listInstances(platform, image).length === 0) {
    return true;
  }
  logger.warn(
    'The archive changed (new build or pull) — the working sandboxes are clones of the previous image.',
  );
  return confirmDefault(
    'Using the new image re-extracts the pristine VM and drops the working instances (their guest state \u2014 installs, config, agent files \u2014 is lost). Continue?',
    { default: 'n', yes: context.options.yes, ...streams },
  );
}

/** Extracts the pristine chunks into base/ (identity-marker gated; a
 *  changed image asks first — declining keeps the previous base +
 *  working instances and the run continues on the old image — then
 *  re-extracts; the extracted base is validated — the disks the vmx
 *  references must sit next to it).
 *
 * @param platform - The target platform.
 * @param context - The run context.
 * @param partsDir - The parts directory to extract.
 */
async function ensureBase(
  platform: Platform,
  context: RunContext,
  partsDir: string,
): Promise<void> {
  const image = context.image;
  const markerPath = baseMarker(platform, image);
  const baseDirPath = vmwareBaseDir(platform, image);
  const baseVmxPath = baseVmx(platform, image);
  const id = partsIdentity(requirePartsRecord(partsDir));

  const hadMarker = existsSync(markerPath);
  const marker = hadMarker ? readFileSync(markerPath, 'utf8').trim() : '';
  if (hadMarker && marker !== id) {
    if (!(await shouldReextract(context, platform, image))) {
      logger.warn(
        'Kept the previous image and the working instances \u2014 this run continues on them (accept the prompt next time to switch to the new image).',
      );
      return;
    }
    logger.warn(
      'The archive changed (new build or pull) — re-extracting the pristine VM and dropping all working instances.',
    );
    logger.warn(
      'The working clones\u2019 guest state (installs, config, agent files) is lost with it.',
    );
    dropBaseState(platform, image);
  }
  if (marker === id && existsSync(baseVmxPath)) {
    const missing = missingBaseDisks(baseDirPath, baseVmxPath);
    if (missing.length === 0) {
      logger.ok(`Pristine VM extracted (${baseDirPath}).`);
      return;
    }
    // A corrupt extraction (an old on-demand pack stored the disks under
    // the build path) — drop it; the re-extraction below fails loudly if
    // the chunked image itself is the broken one.
    logger.warn(
      `The pristine extraction is incomplete (missing ${missing.join(', ')}) — re-extracting.`,
    );
    dropBaseState(platform, image);
  }
  mkdirSync(baseDirPath, { recursive: true });
  await extractBase(platform, image, partsDir, id);
}

/** Extracts the chunked image into base/ (the parts stream straight
 *  into tar, so the whole tar.gz is never materialized on disk) and
 *  validates the result: the disks the vmx references must sit next to
 *  it, then the identity marker is written.
 *
 * @param platform - The target platform.
 * @param image - The image name.
 * @param partsDir - The parts directory to extract.
 * @param id - The image identity to record in the marker.
 * @throws Error when the parts record is missing (requirePartsRecord).
 */
async function extractBase(
  platform: Platform,
  image: string,
  partsDir: string,
  id: string,
): Promise<void> {
  const baseDirPath = vmwareBaseDir(platform, image);
  const baseVmxPath = baseVmx(platform, image);
  const record = requirePartsRecord(partsDir);
  logger.cmd(`tar -xzf - -C ${baseDirPath} (${record.parts.length} chunks from ${partsDir})`);
  const res = await run('tar', ['-xzf', '-', '-C', baseDirPath], {
    stdin: createPartsReadStream(partsDir, record.parts),
  });
  if (res.code !== 0) {
    logger.die(`chunked image extraction failed:\n${res.stderr.trim()}`);
  }
  if (!existsSync(baseVmxPath)) {
    logger.die(`chunked image extraction produced no ${baseVmxPath} (is the image valid?)`);
  }
  const missing = missingBaseDisks(baseDirPath, baseVmxPath);
  if (missing.length > 0) {
    logger.die(
      `the chunked image in ${partsDir} is invalid: the vmx references ${missing.join(', ')} next to itself but the image does not provide ${missing.length > 1 ? 'them' : 'it'}. Remove it and re-run to pull the image again.`,
    );
  }
  writeFileSync(baseMarker(platform, image), id);
  logger.ok(`Pristine VM extracted (${baseVmxPath}).`);
}
