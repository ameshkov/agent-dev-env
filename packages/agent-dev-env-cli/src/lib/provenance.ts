// lib/provenance.ts — the per-image provenance records, shared by all
// four backends. Two host-side JSON files live under the per-image state
// root (<data>/<platform>/<image>/), next to the existing
// backing-image.txt / base-archive.txt identity markers:
//
//   image.json - the pristine image: the GHCR ref it was pulled from
//                (+ the resolved registry digest, best-effort) and when.
//   clone.json - the working VM: what it was cloned from (tart clone /
//                qcow2 overlay / vmx clone), when, and the pristine
//                artifact identity (path|size|mtime) it was derived from.
//
// Together they answer "which image is this sandbox from" on any host
// without booting the VM — the macOS backend has no other host footprint
// by design. The guest itself additionally carries a baked-in identity
// file (see the Packer templates): ~/.config/agent-dev-env/image.json.
//
// The records are best-effort and never fatal: resolveRegistryDigest()
// returns undefined on any failure, read*Record() tolerates missing and
// corrupt files, and the runners only write records when they happen.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandExists, run } from './exec.js';
import { imageRootDir, instanceDir } from './paths.js';
import type { Platform } from './platform.js';

/** The schema version of every provenance record (future shape changes
 *  bump it). */
const PROVENANCE_SCHEMA = 1;

/** How the working VM was created. */
type CloneSourceType = 'tart' | 'qcow2' | 'vmx';

/** The pristine-source side of a clone record. */
interface CloneSourceInfo {
  /** The clone mechanism (tart clone / qemu-img overlay / vmrun clone). */
  type: CloneSourceType;
  /** The local source: tart image name, pristine disk or base vmx path. */
  name: string;
  /** The GHCR ref when the source came from the registry. */
  registryRef?: string;
  /** The registry digest (best-effort, resolved at pull time). */
  digest?: string;
  /** The pristine artifact identity (path|size|mtime, qcow2/vmx). */
  baseIdentity?: string;
}

/** The host-side record of one working-VM clone. */
export interface CloneRecord {
  schema: number;
  platform: Platform;
  /** The pristine image name. */
  image: string;
  /** The sandbox instance name this working VM belongs to. */
  instance: string;
  /** The working VM (tart name / overlay / vmx) this record describes. */
  vm: string;
  clonedFrom: CloneSourceInfo;
  /** ISO 8601 clone time; undefined for backfilled records whose clone
   *  time could not be approximated. */
  clonedAt?: string;
  /** True when written for a pre-existing working VM (local facts only —
   *  no registry info, the clone time is an approximation). */
  backfilled?: boolean;
}

/** The host-side record of one image pull. */
export interface ImageRecord {
  schema: number;
  platform: Platform;
  image: string;
  registryRef: string;
  digest?: string;
  /** ISO 8601 pull time. */
  pulledAt: string;
}

/** The clone record path (<data>/<platform>/<image>/working/<instance>/clone.json).
 *
 * @internal — test-only export (the corrupt-record fixture); production
 * callers go through readCloneRecord/clearCloneRecord.
 * @param platform - The platform id.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The clone record path.
 */
export function cloneRecordPath(platform: Platform, image: string, instance: string): string {
  return join(instanceDir(platform, image, instance), 'clone.json');
}

/** The image record path (<data>/<platform>/<image>/image.json).
 * @param platform - The platform id.
 * @param image - The image name.
 * @returns The image record path.
 */
function imageRecordPath(platform: Platform, image: string): string {
  return join(imageRootDir(platform, image), 'image.json');
}

/** Writes a JSON file atomically-ish (write + parent mkdir; the records
 *  are small, a torn write only loses best-effort provenance). */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Reads a JSON file, tolerating missing files and corrupt content. */
function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Records the working-VM clone provenance. Skips when a record already
 *  exists and backfilled is set (backfill must not clobber a fresh
 *  record); merges the image record's registry ref/digest unless the
 *  caller overrides them.
 *
 * @param opts - The record input (platform/image/instance/vm + source facts).
 */
export function recordClone(opts: {
  platform: Platform;
  image: string;
  instance: string;
  vm: string;
  type: CloneSourceType;
  name: string;
  baseIdentity?: string;
  registryRef?: string;
  digest?: string;
  /** Backfill: skip when a record exists; clonedAt from the argument. */
  backfilled?: boolean;
  clonedAt?: string;
}): void {
  const { platform, image, instance, vm, type, name, backfilled } = opts;
  if (backfilled && readCloneRecord(platform, image, instance)) {
    return;
  }
  const imageRecord = readImageRecord(platform, image);
  writeJson(cloneRecordPath(platform, image, instance), {
    schema: PROVENANCE_SCHEMA,
    platform,
    image,
    instance,
    vm,
    clonedFrom: {
      type,
      name,
      registryRef: opts.registryRef ?? imageRecord?.registryRef,
      digest: opts.digest ?? imageRecord?.digest,
      baseIdentity: opts.baseIdentity,
    },
    clonedAt: opts.clonedAt ?? (backfilled ? undefined : new Date().toISOString()),
    ...(backfilled ? { backfilled: true } : {}),
  });
}

/** Records an image pull (called right after a pull succeeds).
 * @param opts - The record input.
 */
export function writeImageRecord(opts: {
  platform: Platform;
  image: string;
  registryRef: string;
  digest?: string;
}): void {
  writeJson(imageRecordPath(opts.platform, opts.image), {
    schema: PROVENANCE_SCHEMA,
    platform: opts.platform,
    image: opts.image,
    registryRef: opts.registryRef,
    digest: opts.digest,
    pulledAt: new Date().toISOString(),
  });
}

/** Reads the clone record (undefined when missing or unreadable).
 * @param platform - The platform id.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The record, or undefined.
 */
export function readCloneRecord(
  platform: Platform,
  image: string,
  instance: string,
): CloneRecord | undefined {
  return readJson<CloneRecord>(cloneRecordPath(platform, image, instance));
}

/** Reads the image record (undefined when missing or unreadable).
 * @param platform - The platform id.
 * @param image - The image name.
 * @returns The record, or undefined.
 */
export function readImageRecord(platform: Platform, image: string): ImageRecord | undefined {
  return readJson<ImageRecord>(imageRecordPath(platform, image));
}

/** Removes the clone record and the instance state dir (the working VM is
 *  gone or will be re-cloned). The record lives inside
 *  <data>/<platform>/<image>/working/<instance>/, and instance discovery
 *  (listInstances) keys on that directory's presence — keeping the empty
 *  dir would surface the instance in `status` as "not created" forever.
 *  Removing just the file is never wanted: no call site clears a record
 *  while keeping the instance state.
 *
 * @param platform - The platform id.
 * @param image - The image name.
 * @param instance - The instance name.
 */
export function clearCloneRecord(platform: Platform, image: string, instance: string): void {
  rmSync(instanceDir(platform, image, instance), { recursive: true, force: true });
}

/** Removes the image record (the pristine image was deleted).
 * @param platform - The platform id.
 * @param image - The image name.
 */
export function clearImageRecord(platform: Platform, image: string): void {
  rmSync(imageRecordPath(platform, image), { force: true });
}

/** The status/summary line for a working VM with no clone record.
 *  Backfilled records are written by the next `run`; this is shown for
 *  VMs cloned before provenance tracking. */
export const CLONE_RECORD_MISSING =
  'not recorded — cloned before provenance tracking (re-clone with --reset to record)';

/** Formats a clone record for status/summary lines.
 * @param record - The clone record.
 * @returns A one-line description, e.g.
 *   `sandbox-macos-tahoe <- tart ghcr.io/...:latest @ sha256:...; cloned 2026-08-19`
 */
export function describeCloneRecord(record: CloneRecord): string {
  const cf = record.clonedFrom;
  let from = cf.type;
  if (cf.registryRef) {
    from += ` ${cf.registryRef}`;
    if (cf.digest) {
      from += ` @ ${cf.digest}`;
    }
  } else if (cf.name && cf.name !== record.image) {
    from += ` ${cf.name}`;
  }
  const when = record.backfilled
    ? `cloned ${record.clonedAt ? `~${record.clonedAt} ` : ''}(backfilled)`
    : `cloned ${record.clonedAt}`;
  return `${record.image} <- ${from}; ${when}`;
}

/** Formats an image record for status lines.
 * @param record - The image record.
 * @returns A one-line description.
 */
export function describeImageRecord(record: ImageRecord): string {
  const digest = record.digest ? ` @ ${record.digest}` : '';
  return `${record.registryRef}${digest} (pulled ${record.pulledAt})`;
}

/** The clone-source line for summaries: the recorded provenance, or the
 *  "cloned before tracking" hint.
 * @param platform - The platform id.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The one-line description.
 */
export function cloneSourceLine(platform: Platform, image: string, instance: string): string {
  const clone = readCloneRecord(platform, image, instance);
  return clone ? describeCloneRecord(clone) : CLONE_RECORD_MISSING;
}

/** Best-effort registry digest of a ref (oras manifest fetch
 *  --descriptor). Returns undefined on any failure — the record must
 *  never fail the run because provenance metadata could not be resolved.
 *
 * @param ref - The registry ref (ghcr.io/<owner>/<image>:<tag>).
 * @returns The digest (e.g. `sha256:…`), or undefined.
 */
export async function resolveRegistryDigest(ref: string): Promise<string | undefined> {
  if (!commandExists('oras')) {
    return undefined;
  }
  const res = await run('oras', ['manifest', 'fetch', '--descriptor', ref], {
    timeoutMs: 30_000,
  });
  if (res.code !== 0) {
    return undefined;
  }
  return parseDescriptorDigest(res.stdout);
}

/** @internal — Parses the `oras manifest fetch --descriptor` JSON output.
 * @param output - The raw stdout.
 * @returns The digest, or undefined when unparseable.
 */
export function parseDescriptorDigest(output: string): string | undefined {
  try {
    const parsed = JSON.parse(output) as { digest?: string };
    return typeof parsed.digest === 'string' ? parsed.digest : undefined;
  } catch {
    return undefined;
  }
}
