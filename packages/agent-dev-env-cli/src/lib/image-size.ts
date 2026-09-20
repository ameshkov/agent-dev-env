// lib/image-size.ts — how big an image really is: the measured footprint
// of an already-pulled image (the VMware chunks + extracted base, the
// QEMU pristine qcow2, the Tart VM) or, when nothing is pulled, the
// published GHCR download size (the sum of the manifest's layer sizes).
// doctor's free-disk check sizes itself with this instead of the vars
// files' virtual `disk_size`, so the reported number always matches the
// real image.

import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { commandFailure, run as defaultRun, type RunOptions, type RunResult } from './exec.js';
import { vmwareBaseDir, vmwarePartsDir } from './paths.js';
import type { Platform } from './platform.js';
import { qemuImagePath, qemuPartsDir } from './qemu.js';
import { withRetries, type RetryOptions } from './retry.js';
import { listVmSizes } from './tart.js';

/** Where an image size came from: the pulled image's footprint or the
 *  published GHCR download. */
type ImageSizeSource = 'local' | 'registry';

/** An image's real size and where it came from. */
export interface ImageSize {
  /** The size in bytes: allocated on disk for `local`, the manifest's
   *  layer sum for `registry`. */
  bytes: number;
  /** `local` = the pulled image's measured footprint; `registry` = the
   *  GHCR download size. */
  source: ImageSizeSource;
}

/** The injectable process runner (tests pass a fake, production uses
 *  lib/exec's run). */
type ExecFn = (cmd: string, args?: string[], options?: RunOptions) => Promise<RunResult>;

/** Fetch/retry overrides (tests). */
interface ImageSizeOptions {
  exec?: ExecFn;
  retry?: RetryOptions;
}

/** The resolve options: the ref to size when nothing is pulled + the
 *  fetch overrides. */
interface ResolveImageSizeOptions extends ImageSizeOptions {
  ref?: string;
}

/** The manifest fetches are small — keep doctor's wait short. */
const MANIFEST_ATTEMPTS = 2;
const MANIFEST_RETRY_DELAY_MS = 1_000;
const MANIFEST_TIMEOUT_MS = 30_000;

/** @internal — Sums an OCI manifest's layer sizes: the real download
 *  size (works for both the chunked image artifacts and Tart images).
 *  Test-only export; resolveImageSize() calls it.
 *
 * @param json - The parsed `oras manifest fetch` output.
 * @returns The total bytes, or undefined when the manifest has no
 *   well-formed layers (not an image artifact).
 */
export function sumManifestLayerBytes(json: unknown): number | undefined {
  const layers = asRecord(json)?.layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    return undefined;
  }
  let total = 0;
  for (const layer of layers) {
    const size = asRecord(layer)?.size;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      return undefined;
    }
    total += size;
  }
  return total;
}

/** The object view of an unknown JSON value (undefined for anything
 *  else).
 *
 * @param value - The JSON value to inspect.
 * @returns The value as a record, or undefined.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** @internal — The bytes a file or directory tree occupies on disk
 *  (allocated blocks; the file size is the fallback when a filesystem
 *  reports no allocation). Missing paths and symlinks count as zero — a
 *  VM tree is never followed outside itself. Test-only export;
 *  localImageBytes() calls it.
 *
 * @param path - The file or directory to measure.
 * @returns The allocated bytes (0 when the path does not exist).
 */
export function pathBytes(path: string): number {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return 0;
  }
  if (stats.isSymbolicLink()) {
    return 0;
  }
  if (!stats.isDirectory()) {
    return stats.blocks > 0 ? stats.blocks * 512 : stats.size;
  }
  let total = 0;
  for (const entry of readdirSync(path)) {
    total += pathBytes(join(path, entry));
  }
  return total;
}

/** @internal — The measured footprint of the pulled image: the Tart VM
 *  size for macOS, the pristine qcow2 (+ any chunk staging) for QEMU,
 *  the chunks + extracted base for the VMware backends. Test-only
 *  export; resolveImageSize() calls it.
 *
 * @param platform - The platform to size.
 * @param image - The image name.
 * @param options - The registry ref the image may be staged under
 *   (`tart pull` stages images under their OCI reference).
 * @returns The bytes, or undefined when nothing is pulled.
 */
export async function localImageBytes(
  platform: Platform,
  image: string,
  options: { ref?: string } = {},
): Promise<number | undefined> {
  if (platform === 'macos') {
    const sizes = await listVmSizes();
    return sizes.get(image) ?? (options.ref ? sizes.get(options.ref) : undefined);
  }
  const paths =
    platform === 'windows-qemu'
      ? [qemuImagePath(image), qemuPartsDir(image)]
      : [vmwarePartsDir(platform, image), vmwareBaseDir(platform, image)];
  const bytes = paths.reduce((total, path) => total + pathBytes(path), 0);
  return bytes > 0 ? bytes : undefined;
}

/** The published image size: `oras manifest fetch` + the layer sum.
 *
 * @param ref - The registry ref (ghcr.io/<owner>/<image>:<tag>).
 * @param options - Exec/retry overrides (tests).
 * @returns The download size in bytes.
 * @throws Error when the manifest cannot be fetched or has no layers.
 */
async function registryImageBytes(ref: string, options: ImageSizeOptions): Promise<number> {
  const exec = options.exec ?? defaultRun;
  const args = ['manifest', 'fetch', ref];
  const res = await withRetries(
    async () => {
      const result = await exec('oras', args, { timeoutMs: MANIFEST_TIMEOUT_MS });
      if (result.code !== 0) {
        throw commandFailure('oras', args, result);
      }
      return result;
    },
    {
      attempts: MANIFEST_ATTEMPTS,
      delayMs: MANIFEST_RETRY_DELAY_MS,
      ...options.retry,
      label: `oras ${args.join(' ')}`,
    },
  );
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new Error(`oras returned an unreadable manifest for ${ref}`);
  }
  const bytes = sumManifestLayerBytes(json);
  if (bytes === undefined) {
    throw new Error(`oras returned no image layers for ${ref} (is it an image artifact?)`);
  }
  return bytes;
}

/** The image's real size: the measured local footprint when the image is
 *  already pulled, otherwise the published GHCR download size.
 *
 * @param platform - The platform to size.
 * @param image - The image name.
 * @param options - The registry ref to fall back to + exec/retry
 *   overrides (tests).
 * @returns The size and its source, or undefined when the image is
 *   neither pulled nor resolvable (no ref).
 * @throws Error when the image is not pulled and the registry fetch
 *   fails (callers decide how to report it).
 */
export async function resolveImageSize(
  platform: Platform,
  image: string,
  options: ResolveImageSizeOptions = {},
): Promise<ImageSize | undefined> {
  const local = await localImageBytes(platform, image, options);
  if (local !== undefined) {
    return { bytes: local, source: 'local' };
  }
  if (!options.ref) {
    return undefined;
  }
  return { bytes: await registryImageBytes(options.ref, options), source: 'registry' };
}
