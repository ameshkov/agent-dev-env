// runners/parts-pull.ts — pulling a chunked image artifact from GHCR:
// fetch the manifest (descriptor + layers), then fetch each part with
// `oras blob fetch` (one layer per request, digest-verified by oras).
// Every request is retried with backoff — a fresh attempt re-resolves
// the layer, so an expired signed URL is replaced — and parts that are
// already on disk with the right size are skipped, so a transfer killed
// by the registry's signed-URL expiry or a dropped connection only
// costs the part that was in flight: a retry converges instead of
// restarting a 22 GiB blob from zero.

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { run as defaultRun, commandFailure, type RunOptions, type RunResult } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import {
  assertPartsComplete,
  missingParts,
  writePartsRecord,
  type PartInfo,
  type PartsRecord,
} from '../lib/parts.js';
import { parseImageManifest } from '../lib/parts-manifest.js';
import { parseDescriptorDigest } from '../lib/provenance.js';
import { errorDetail, withRetries, type RetryOptions } from '../lib/retry.js';

/** @internal — the injectable process runner (test-only export; tests
 *  pass a fake, production uses lib/exec's run). */
export type ExecFn = (cmd: string, args?: string[], options?: RunOptions) => Promise<RunResult>;

/** How many parts are fetched at once. */
const PULL_CONCURRENCY = 3;

/** Attempts per chunk. Every attempt re-resolves the layer, so an
 *  expired signed URL is replaced; the backoff covers registry 429/5xx
 *  and dropped connections. */
const PART_ATTEMPTS = 4;
const PART_RETRY_DELAY_MS = 2_000;
const PART_RETRY_MAX_DELAY_MS = 30_000;

/** The manifest/descriptor fetches are small — retry them quickly. */
const MANIFEST_ATTEMPTS = 3;
const MANIFEST_RETRY_DELAY_MS = 1_000;
const MANIFEST_RETRY_MAX_DELAY_MS = 5_000;

const DESCRIPTOR_TIMEOUT_MS = 30_000;
const MANIFEST_TIMEOUT_MS = 60_000;

/** The inputs for one chunked pull. */
export interface PullImagePartsOptions {
  /** The registry ref (ghcr.io/<owner>/<image>:<tag>). */
  ref: string;
  /** The parts directory to fill (created when missing). */
  partsDir: string;
  /** Parallel fetches (default PULL_CONCURRENCY). */
  concurrency?: number;
  /** Retry overrides for the manifest fetches and the chunks (tests
   *  pass zero delays; production uses the constants above). */
  retry?: RetryOptions;
  /** Process runner override (tests). */
  exec?: ExecFn;
}

/** Pulls a chunked image artifact into partsDir: manifest first (the
 *  digest is recorded, and the manifest alone decides what to fetch),
 *  then the missing parts, then a completeness check. Parts already on
 *  disk are kept.
 *
 * @param options - Ref, destination dir, retry/concurrency/exec
 *   overrides.
 * @returns The parts record of the pulled image.
 * @throws Error when the ref is not a chunked image, the manifest cannot
 *   be fetched, or any part cannot be fetched.
 */
export async function pullImageParts(options: PullImagePartsOptions): Promise<PartsRecord> {
  const exec = options.exec ?? defaultRun;
  const manifestDigest = await fetchManifestDigest(exec, options.ref, options.retry);
  const manifest = await fetchManifest(exec, options.ref, options.retry);
  const record = parseImageManifest(manifest, { registryRef: options.ref, manifestDigest });
  mkdirSync(options.partsDir, { recursive: true });
  writePartsRecord(options.partsDir, record);
  const todo = missingParts(options.partsDir, record);
  if (todo.length === 0) {
    logger.info(`All ${record.parts.length} image chunks are already cached.`);
  } else {
    logger.info(
      `Fetching ${todo.length}/${record.parts.length} chunks (${formatSize(record.totalSize)} image)...`,
    );
    await fetchParts(exec, options, todo);
  }
  assertPartsComplete(options.partsDir, record);
  return record;
}

/** `oras manifest fetch --descriptor <ref>` — the manifest digest (the
 *  strongest version identity of the chunk set). */
async function fetchManifestDigest(
  exec: ExecFn,
  ref: string,
  retry?: RetryOptions,
): Promise<string> {
  const args = ['manifest', 'fetch', '--descriptor', ref];
  const res = await withRetries(() => oras(exec, args, { timeoutMs: DESCRIPTOR_TIMEOUT_MS }), {
    ...manifestRetry(retry),
    label: `oras ${args.join(' ')}`,
  });
  const digest = parseDescriptorDigest(res.stdout);
  if (!digest) {
    throw new Error(`oras returned no manifest digest for ${ref} (is the image published?)`);
  }
  return digest;
}

/** `oras manifest fetch <ref>` — the layer list that decides the parts. */
async function fetchManifest(exec: ExecFn, ref: string, retry?: RetryOptions): Promise<unknown> {
  const args = ['manifest', 'fetch', ref];
  const res = await withRetries(() => oras(exec, args, { timeoutMs: MANIFEST_TIMEOUT_MS }), {
    ...manifestRetry(retry),
    label: `oras ${args.join(' ')}`,
  });
  try {
    return JSON.parse(res.stdout) as unknown;
  } catch {
    throw new Error(`oras returned an unreadable manifest for ${ref}`);
  }
}

/** One oras invocation with the strict non-zero contract (the retry
 *  wrappers decide how often it runs). */
async function oras(exec: ExecFn, args: string[], options?: RunOptions): Promise<RunResult> {
  const res = await exec('oras', args, options);
  if (res.code !== 0) {
    throw commandFailure('oras', args, res);
  }
  return res;
}

/** Fetches the parts with a bounded number of in-flight requests. */
async function fetchParts(
  exec: ExecFn,
  options: PullImagePartsOptions,
  parts: PartInfo[],
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? PULL_CONCURRENCY);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= parts.length) {
        return;
      }
      await fetchPart(exec, options, parts[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, parts.length) }, () => worker()));
}

/** Fetches one part to `<name>.tmp`, then renames it into place (a
 *  killed fetch leaves only the tmp file, so completeness is always
 *  unambiguous). Each attempt re-resolves the layer, and a truncated
 *  download is detected by size and retried. */
async function fetchPart(
  exec: ExecFn,
  options: PullImagePartsOptions,
  part: PartInfo,
): Promise<void> {
  const target = join(options.partsDir, part.name);
  const tmp = `${target}.tmp`;
  const args = ['blob', 'fetch', '--no-tty', '--output', tmp, `${options.ref}@${part.digest}`];
  try {
    await withRetries(() => fetchPartOnce(exec, args, tmp, part), {
      ...partRetry(options.retry),
      label: `chunk ${part.name}`,
    });
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new Error(`failed to fetch ${part.name}: ${errorDetail(err)}`, { cause: err });
  }
  renameSync(tmp, target);
  logger.info(`downloaded ${part.name} (${formatSize(part.size)}).`);
}

/** One chunk attempt: the fetch plus the exact-size check. */
async function fetchPartOnce(
  exec: ExecFn,
  args: string[],
  tmp: string,
  part: PartInfo,
): Promise<void> {
  rmSync(tmp, { force: true });
  await oras(exec, args);
  const size = existsSync(tmp) ? statSync(tmp).size : 0;
  if (size !== part.size) {
    throw new Error(`incomplete download (${formatSize(size)} of ${formatSize(part.size)})`);
  }
}

/** The manifest-fetch retry options, with test overrides on top. */
function manifestRetry(overrides?: RetryOptions): RetryOptions {
  return {
    attempts: MANIFEST_ATTEMPTS,
    delayMs: MANIFEST_RETRY_DELAY_MS,
    maxDelayMs: MANIFEST_RETRY_MAX_DELAY_MS,
    ...overrides,
  };
}

/** The chunk-fetch retry options, with test overrides on top. */
function partRetry(overrides?: RetryOptions): RetryOptions {
  return {
    attempts: PART_ATTEMPTS,
    delayMs: PART_RETRY_DELAY_MS,
    maxDelayMs: PART_RETRY_MAX_DELAY_MS,
    ...overrides,
  };
}

/** A compact byte size for log lines. */
function formatSize(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)} GiB` : `${Math.round(mib)} MiB`;
}
