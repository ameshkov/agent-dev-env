// lib/vmware-archive.ts — packing the VMware/Ubuntu build output into
// the chunked archive shared by `deploy` (push) and the run flow (the
// on-demand local pack). The members (vmx + nvram + every vmdk, never
// the vmware logs) are tarred with RELATIVE names — tar (bsdtar) stores
// an ABSOLUTE member as its full path inside the archive and the disks
// then extract under the build path instead of the base root, which
// breaks the vmrun clone — and the tar is split into parts; it is
// deleted as soon as the parts are complete.
//
// The parts directory (<output>/parts + parts.json) is the same layout
// the runner extracts from, so a locally packed image and a pulled one
// take the identical code path.

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './exec.js';
import { logger } from './logger.js';
import {
  PART_SIZE_BYTES,
  PARTS_VERIFIED_NAME,
  VMWARE_ARTIFACT_TYPE,
  createPartsReadStream,
  partsAreCurrent,
  partsIdentity,
  readPartsRecord,
  splitFileToParts,
  type PartsRecord,
} from './parts.js';

/** The parts directory inside a build output dir. */
export function partsDirOf(outputDir: string): string {
  return join(outputDir, 'parts');
}

/** The archive members (relative to outputDir). The vmdks are sorted so
 *  the same build output always produces the same bytes — and thus the
 *  same part digests. */
function vmwareArchiveMembers(outputDir: string, image: string): string[] {
  const vmdks = readdirSync(outputDir)
    .filter((file) => file.endsWith('.vmdk'))
    .sort();
  return [`${image}.vmx`, `${image}.nvram`, ...vmdks];
}

/** @internal — Packs the build output into a temporary tar.gz, splits it
 *  into parts, deletes the tar (the parts are the artifact now), and
 *  writes the parts record (test-only export; ensureVmwareLocalParts
 *  calls it within this module).
 *
 * @param outputDir - The build output dir (cwd for the relative names).
 * @param image - The image name (vmx/nvram file prefix).
 * @param partSize - The part size (tests; default PART_SIZE_BYTES).
 * @returns The parts record.
 * @throws Error when tar fails or the split cannot complete.
 */
export async function packVmwareArchiveParts(
  outputDir: string,
  image: string,
  partSize: number = PART_SIZE_BYTES,
): Promise<PartsRecord> {
  const members = vmwareArchiveMembers(outputDir, image);
  const tarPath = join(outputDir, `${image}.tar.gz`);
  logger.cmd(`tar -czf ${tarPath} ${members.join(' ')}`);
  const res = await run('tar', ['-czf', tarPath, ...members], { cwd: outputDir });
  if (res.code !== 0) {
    throw new Error(`tar failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const partsDir = partsDirOf(outputDir);
  rmSync(partsDir, { recursive: true, force: true });
  try {
    return await splitFileToParts(
      tarPath,
      partsDir,
      { kind: 'tar.gz', artifactType: VMWARE_ARTIFACT_TYPE },
      partSize,
    );
  } finally {
    rmSync(tarPath, { force: true });
  }
}

/** Packs the build output only when the parts are missing or stale
 *  (parts.json older than the newest member), otherwise reuses them —
 *  a redeploy after a failed push must not re-pack 22 GiB. */
export async function ensureVmwareArchiveParts(
  outputDir: string,
  image: string,
): Promise<PartsRecord> {
  const partsDir = partsDirOf(outputDir);
  const sources = vmwareArchiveMembers(outputDir, image).map((member) => join(outputDir, member));
  if (partsAreCurrent(sources, partsDir)) {
    const record = readPartsRecord(partsDir);
    if (record) {
      return record;
    }
  }
  logger.info(`No current chunks for ${image} — packing the build output.`);
  return packVmwareArchiveParts(outputDir, image);
}

/** The local verification marker path (<output>/parts.verified). */
function verifiedMarker(outputDir: string): string {
  return join(outputDir, PARTS_VERIFIED_NAME);
}

/** Whether the local parts passed the disks-at-root listing check for
 *  their current identity. The tar listing re-decompresses the whole
 *  archive, so the check runs ONCE per chunk set — not on every
 *  invocation. */
function localPartsVerified(outputDir: string, identity: string): boolean {
  const marker = verifiedMarker(outputDir);
  return existsSync(marker) && readFileSync(marker, 'utf8').trim() === identity;
}

/** Ensures the local build output is a valid chunked archive: packs it
 *  when missing/stale, verifies the disks-at-root layout once per
 *  identity, re-packs a corrupt one, and records the verification
 *  marker.
 *
 * @param outputDir - The build output dir.
 * @param image - The image name.
 * @returns The valid parts record.
 */
export async function ensureVmwareLocalParts(
  outputDir: string,
  image: string,
): Promise<PartsRecord> {
  let record = await ensureVmwareArchiveParts(outputDir, image);
  if (localPartsVerified(outputDir, partsIdentity(record))) {
    return record;
  }
  const partsDir = partsDirOf(outputDir);
  if (await partsHaveRootDisks(partsDir, record)) {
    writeFileSync(verifiedMarker(outputDir), partsIdentity(record));
    return record;
  }
  logger.warn(
    `The local chunks in ${partsDir} are corrupt (their disks are stored under the build path, not at the archive root) — re-packing them.`,
  );
  record = await packVmwareArchiveParts(outputDir, image);
  writeFileSync(verifiedMarker(outputDir), partsIdentity(record));
  return record;
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

/** Whether the parts reassemble into a stream whose .vmdk members sit at
 *  the archive root (an unreadable stream also counts as invalid — a
 *  partially-written chunk set must be re-packed). */
async function partsHaveRootDisks(partsDir: string, record: PartsRecord): Promise<boolean> {
  const res = await run('tar', ['-tzf', '-'], {
    stdin: createPartsReadStream(partsDir, record.parts),
  });
  if (res.code !== 0) {
    return false;
  }
  return archiveHasRootDisks(res.stdout.split('\n').map((line) => line.trim()));
}
