// runners/vmware-image-archive.ts — step 1a for the VMware backends
// (ubuntu-vmware and windows-vmware, Phase 4 + Phase 5): pick the image
// archive (env override → local build output → cached pull → oras pull)
// and extract the pristine base/ (identity marker = path|size|mtime, so a
// rebuild over the same path is detected). The clone step lives in
// vmware-image.ts; the archive layout here MUST match the one
// lifecycle/deploy.ts packs for oras (relative member names).
//
// Port of run-{ubuntu,windows}-vmware-sandbox.sh §pick_image + base
// extraction; the CLI's data dir replaces the legacy one. The
// per-platform pieces (platform id, the archive override env var) are
// parameters, so the two VMware backends share one implementation.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { commandExists, run } from '../lib/exec.js';
import { registryRef, resolveOwner } from '../lib/ghcr.js';
import { logger } from '../lib/logger.js';
import { buildDir, imageRootDir, listInstances, vmwareArchivePath } from '../lib/paths.js';
import type { Platform } from '../lib/platform.js';
import { confirmDefault, type ConfirmOptions } from '../lib/prompt.js';
import { resolveRegistryDigest, writeImageRecord } from '../lib/provenance.js';
import type { RunContext } from './framework.js';

/** The pristine-archive identity (path|size|mtime; the same scheme as the
 *  QEMU runner's backing-image marker — a rebuild packs the new image at
 *  the SAME path, so the path alone misses it).
 *
 * @param path - The archive path.
 * @param size - File size in bytes.
 * @param mtimeMs - File mtime (ms since epoch).
 * @returns The identity string.
 */
export function archiveIdentity(path: string, size: number, mtimeMs: number): string {
  return `${path}|${size}|${Math.floor(mtimeMs / 1000)}`;
}

/** The base directory of the pristine extraction. */
function baseDir(platform: Platform, image: string): string {
  return join(imageRootDir(platform, image), 'base');
}

/** The pristine base vmx (the clone source).
 *
 * @param platform - The target platform.
 * @param image - The image name.
 * @returns The base vmx path.
 */
export function baseVmx(platform: Platform, image: string): string {
  return join(baseDir(platform, image), `${image}.vmx`);
}

/** The archive identity marker path. */
function baseMarker(platform: Platform, image: string): string {
  return join(imageRootDir(platform, image), 'base-archive.txt');
}

/** @internal — the on-demand archive of the local build output (vmx +
 *  nvram + every vmdk; the member names are explicit so no logs land in
 *  it). The member names MUST be relative to outputDir: tar (bsdtar)
 *  stores an ABSOLUTE member as its full path inside the archive (it only
 *  strips the leading slash), so a '/Users/…/disk.vmdk' member extracts
 *  into base/Users/… and the vmrun clone breaks — the base vmx references
 *  disk.vmdk next to itself. lifecycle/deploy.ts packs the same layout for
 *  oras; keep the two in sync.
 *
 * @param outputDir - The build output dir (cwd for the relative names).
 * @param image - The image name (vmx/nvram file prefix).
 * @param artifact - The tar.gz to create.
 * @returns The raw tar result.
 */
export async function packVmwareLocalArchive(
  outputDir: string,
  image: string,
  artifact: string,
): Promise<ReturnType<typeof run>> {
  const vmdks = readdirSync(outputDir).filter((file) => file.endsWith('.vmdk'));
  const members = [`${image}.vmx`, `${image}.nvram`, ...vmdks];
  return run('tar', ['-czf', artifact, ...members], { cwd: outputDir });
}

/** @internal — whether every .vmdk member of a tar listing sits at the
 *  archive root (the corrupt-pack check for the on-demand archive: a bad
 *  pack stores the disks under the full build path instead).
 *
 * @param members - The tar member names (tar -tzf output lines).
 * @returns True when every .vmdk member is a plain top-level basename.
 */
export function archiveHasRootDisks(members: string[]): boolean {
  return members
    .filter((member) => member.endsWith('.vmdk'))
    .every((member) => !member.includes('/'));
}

/** Whether the archive lists its .vmdk members at the archive root (the
 *  archiveHasRootDisks check with the tar listing; an unreadable archive
 *  also counts as invalid — a partially-written one must be re-packed).
 *
 * @param archive - The tar.gz path.
 * @returns True when the archive is readable and its disks are at the root.
 */
async function archiveDisksAtRoot(archive: string): Promise<boolean> {
  const res = await run('tar', ['-tzf', archive]);
  if (res.code !== 0) {
    return false;
  }
  return archiveHasRootDisks(res.stdout.split('\n').map((line) => line.trim()));
}

/** The verified marker path of the on-demand archive (records the archive
 *  identity once the disks-at-root check passed). */
function localArchiveMarker(local: string): string {
  return `${local}.verified`;
}

/** Whether the local archive already passed the disks-at-root check for
 *  its current version (the marker records the identity). The tar listing
 *  re-decompresses the whole archive, so the check runs ONCE per archive
 *  version — not on every invocation; archives packed by the fixed code
 *  carry a fresh marker and are never listed again.
 *
 * @param local - The on-demand archive path.
 * @returns True when the marker matches the archive's current identity.
 */
function localArchiveVerified(local: string): boolean {
  const marker = localArchiveMarker(local);
  if (!existsSync(marker)) {
    return false;
  }
  const stat = statSync(local);
  return readFileSync(marker, 'utf8').trim() === archiveIdentity(local, stat.size, stat.mtimeMs);
}

/** Packs the local build output into the on-demand archive and records
 *  the verified marker (the pack lists the disks relative, so a freshly
 *  packed archive is valid by construction — no listing needed).
 *
 * @param outputDir - The build output dir (cwd for the relative names).
 * @param image - The image name.
 * @param local - The on-demand archive path.
 */
async function packLocalArchive(outputDir: string, image: string, local: string): Promise<void> {
  const packed = await packVmwareLocalArchive(outputDir, image, local);
  if (packed.code !== 0) {
    logger.die(`failed to pack the local build output:\n${packed.stderr.trim()}`);
  }
  const stat = statSync(local);
  writeFileSync(localArchiveMarker(local), archiveIdentity(local, stat.size, stat.mtimeMs));
}

/** @internal — Ensures the on-demand archive exists and is valid: packs
 *  it when missing, verifies the disks-at-root layout once per archive
 *  version (marker-gated), re-packs a corrupt one, and records the marker
 *  (test-only export; pickImage calls it within this module).
 *
 * @param outputDir - The build output dir.
 * @param image - The image name.
 * @param local - The on-demand archive path.
 */
export async function ensureLocalArchive(
  outputDir: string,
  image: string,
  local: string,
): Promise<void> {
  if (!existsSync(local)) {
    logger.info(`No archive yet — packing the local build output into ${local}`);
    await packLocalArchive(outputDir, image, local);
    return;
  }
  if (localArchiveVerified(local)) {
    return;
  }
  if (await archiveDisksAtRoot(local)) {
    const stat = statSync(local);
    writeFileSync(localArchiveMarker(local), archiveIdentity(local, stat.size, stat.mtimeMs));
    return;
  }
  logger.warn(
    `The local archive ${local} is corrupt (its disks are stored under the build path, not at the archive root) — re-packing it.`,
  );
  rmSync(local, { force: true });
  await packLocalArchive(outputDir, image, local);
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
 *  archive changed and when the extracted base turns out incomplete).
 *
 * @param platform - The target platform.
 * @param image - The image name.
 */
function dropBaseState(platform: Platform, image: string): void {
  rmSync(baseDir(platform, image), { recursive: true, force: true });
  rmSync(join(imageRootDir(platform, image), 'working'), { recursive: true, force: true });
}

/** Step 1a: pick the archive and extract the pristine base (the clone
 *  step in vmware-image.ts consumes the returned archive).
 *
 * @param platform - The target platform (state dir naming).
 * @param overrideEnv - The env var holding a local archive override
 *   (UBUNTU_VMWARE_IMAGE / WINDOWS_VMWARE_IMAGE).
 * @param context - The run context.
 * @returns The archive path the base was extracted from.
 */
export async function ensureVmwareArchive(
  platform: Platform,
  overrideEnv: string,
  context: RunContext,
): Promise<string> {
  const archive = await pickImage(platform, overrideEnv, context);
  await ensureBase(platform, context, archive);
  return archive;
}

/** The shell's pick_image: <OVERRIDE_ENV> → local build output (packed on
 *  demand) → cached pull → oras pull with the owner chain.
 *
 * @param platform - The target platform.
 * @param overrideEnv - The environment override variable name.
 * @param context - The run context.
 * @returns The archive path to run.
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
    if (!existsSync(override)) {
      logger.die(`${overrideEnv} points to a file that does not exist: ${override}`);
    }
    return override;
  }
  const outputDir = join(buildDir(platform), 'output');
  const local = join(outputDir, `${image}.tar.gz`);
  if (existsSync(join(outputDir, `${image}.vmx`))) {
    await ensureLocalArchive(outputDir, image, local);
  }
  if (existsSync(local)) {
    return local;
  }

  const cached = vmwareArchivePath(platform, image);
  if (existsSync(cached)) {
    return cached;
  }
  return pullImage(platform, overrideEnv, context, cached);
}

/** The oras pull into the image/ cache dir (owner chain + confirm +
 *  archive presence check).
 *
 * @param platform - The target platform.
 * @param overrideEnv - The environment override variable name (prompts).
 * @param context - The run context.
 * @param cached - The destination archive path.
 * @returns The pulled archive path.
 */
async function pullImage(
  platform: Platform,
  overrideEnv: string,
  context: RunContext,
  cached: string,
): Promise<string> {
  if (!commandExists('oras')) {
    logger.die(
      'oras is not installed — needed to pull the image (brew install oras). ' +
        `Set ${overrideEnv} to a local archive to skip.`,
    );
  }
  const owner = await resolveOwner({ owner: context.options.owner, env: context.options.env });
  const ref = registryRef(context.image, 'latest', owner);
  const hint = platform === 'windows-vmware' ? '~20 GB' : '~15 GB';
  if (
    !(await confirmDefault(`Pull ${ref} (one-time, ${hint} download)?`, {
      default: 'y',
      yes: context.options.yes,
    }))
  ) {
    logger.die(
      `aborted — no sandbox image available. Set ${overrideEnv} to a local archive or pull manually.`,
    );
  }
  mkdirSync(dirname(cached), { recursive: true });
  logger.info(`Pulling ${ref} (one-time, ${hint} download)...`);
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
    platform,
    image: context.image,
    registryRef: ref,
    digest,
  });
  return cached;
}

/** @internal — whether a changed archive should be re-extracted
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

/** Extracts the pristine archive into base/ (identity-marker gated; an
 *  archive change asks first — declining keeps the previous base +
 *  working instances and the run continues on the old image — then
 *  re-extracts; the extracted base is validated — the disks the vmx
 *  references must sit next to it).
 *
 * @param platform - The target platform.
 * @param context - The run context.
 * @param archive - The archive to extract.
 */
async function ensureBase(platform: Platform, context: RunContext, archive: string): Promise<void> {
  const image = context.image;
  const markerPath = baseMarker(platform, image);
  const baseDirPath = baseDir(platform, image);
  const baseVmxPath = baseVmx(platform, image);
  const stat = statSync(archive);
  const id = archiveIdentity(archive, stat.size, stat.mtimeMs);

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
    // the archive itself is the broken one.
    logger.warn(
      `The pristine extraction is incomplete (missing ${missing.join(', ')}) — re-extracting.`,
    );
    dropBaseState(platform, image);
  }
  mkdirSync(baseDirPath, { recursive: true });
  await extractBase(platform, image, archive, id);
}

/** Extracts the archive into base/ and validates the result: the disks
 *  the vmx references must sit next to it (a corrupt extraction is
 *  re-packed by the run on the next pull), then writes the identity
 *  marker.
 *
 * @param platform - The target platform.
 * @param image - The image name.
 * @param archive - The archive to extract.
 * @param id - The archive identity to record in the marker.
 */
async function extractBase(
  platform: Platform,
  image: string,
  archive: string,
  id: string,
): Promise<void> {
  const baseDirPath = baseDir(platform, image);
  const baseVmxPath = baseVmx(platform, image);
  logger.cmd(`tar -xzf ${archive} -C ${baseDirPath}`);
  const res = await run('tar', ['-xzf', archive, '-C', baseDirPath]);
  if (res.code !== 0) {
    logger.die(`archive extraction failed:\n${res.stderr.trim()}`);
  }
  if (!existsSync(baseVmxPath)) {
    logger.die(`archive extraction produced no ${baseVmxPath} (is the archive valid?)`);
  }
  const missing = missingBaseDisks(baseDirPath, baseVmxPath);
  if (missing.length > 0) {
    logger.die(
      `archive ${archive} is invalid: the vmx references ${missing.join(', ')} next to itself but the archive does not provide ${missing.length > 1 ? 'them' : 'it'}. Remove the archive and re-run to re-pack it from the local build output.`,
    );
  }
  writeFileSync(baseMarker(platform, image), id);
  logger.ok(`Pristine VM extracted (${baseVmxPath}).`);
}
