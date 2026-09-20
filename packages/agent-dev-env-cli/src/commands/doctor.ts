// commands/doctor.ts — `agent-dev-env doctor [--platform P]`: prereq table
// with install hints and a free-disk check against the real image sizes —
// the measured footprint of a pulled image, or the published GHCR
// download size when nothing is pulled. Supersedes the scattered
// require_cmd blocks; read-only.
//
// Exit code: 1 when any required check fails, 0 otherwise. Optional
// (bridge/build-only) tooling is reported as such and does not fail the
// check; an image size that cannot be determined (offline, oras missing)
// is reported as "unknown" instead of failing.

import { statfsSync } from 'node:fs';
import { listImages, type CatalogImage } from '../lifecycle/catalog.js';
import { commandExists } from '../lib/exec.js';
import { registryRef, resolveOwner } from '../lib/ghcr.js';
import { resolveImageSize, type ImageSize } from '../lib/image-size.js';
import { logger } from '../lib/logger.js';
import { PLATFORM_DEFAULTS, PLATFORMS, type Platform } from '../lib/platform.js';
import { errorDetail } from '../lib/retry.js';
import { findVmrun } from '../lib/vmrun.js';

export interface DoctorOptions {
  /** Restrict the check to a single platform (all when omitted). */
  platform?: Platform;
}

interface Check {
  label: string;
  ok: boolean;
  required: boolean;
  hint: string;
  /** The value could not be determined — shown as "unknown" and never
   *  fails the doctor run (e.g. the image is not pulled and GHCR is
   *  unreachable). */
  unknown?: boolean;
}

/** Runs the prerequisite + free-disk check for one or all platforms.
 *
 * @param options - Platform scoping (all platforms by default).
 * @returns Exit code: 0 when all required checks pass, 1 otherwise.
 */
export async function doctorCmd(options: DoctorOptions = {}): Promise<number> {
  const targets: Platform[] = options.platform ? [options.platform] : [...PLATFORMS];
  let anyFailed = false;
  for (const [i, platform] of targets.entries()) {
    if (i > 0) {
      logger.out('');
    }
    anyFailed = (await printDoctor(platform)) || anyFailed;
  }
  return anyFailed ? 1 : 0;
}

async function printDoctor(platform: Platform): Promise<boolean> {
  logger.title(`Doctor: ${platform} (${PLATFORM_DEFAULTS[platform].image})`);
  const checks = await checksFor(platform);

  const width = Math.max(...checks.map((c) => c.label.length), 'Requirement'.length);
  const statusText = (c: Check): string =>
    c.ok ? 'ok' : c.unknown ? 'unknown' : c.required ? 'missing' : 'optional';

  logger.out(`    ${'Requirement'.padEnd(width)}  Status  Hint`);
  for (const check of checks) {
    const status = statusText(check);
    const color = check.ok ? 'green' : check.unknown ? 'yellow' : 'red';
    const colored = logger.color(color) + status + logger.reset();
    const line = `${check.label.padEnd(width)}  ${colored.padEnd(status.length)}  ${check.hint}`;
    logger.out(line.replace(/\s+$/, ''));
  }

  const failed = checks.filter((c) => c.required && !c.ok);
  if (failed.length === 0) {
    logger.ok('All checks passed.');
  } else {
    logger.warn(`${failed.length} required check(s) failed.`);
  }
  return failed.length > 0;
}

async function checksFor(platform: Platform): Promise<Check[]> {
  const platformChecks =
    platform === 'macos'
      ? macosChecks()
      : platform === 'windows-qemu'
        ? qemuChecks()
        : vmwareChecks();
  return [...(await hostChecks(platform)), ...platformChecks];
}

/** Checks shared by every platform: host, arch, free disk. */
async function hostChecks(platform: Platform): Promise<Check[]> {
  const { size, error } = await platformImageSize(platform);
  return [
    {
      label: 'macOS host',
      ok: process.platform === 'darwin',
      required: true,
      hint: 'the sandbox runners run on macOS only',
    },
    {
      label: 'Apple Silicon',
      ok: process.arch === 'arm64',
      required: true,
      hint: 'Tart/QEMU/Fusion can only virtualize ARM64 guests (Intel unsupported)',
    },
    freeDiskCheck(freeDiskGb(), size, error),
  ];
}

/** @internal — Builds the free-disk check from the resolved numbers
 *  (test-only export; hostChecks calls it with the live values).
 *
 * @param freeGb - Free space in decimal GB (undefined when unknown).
 * @param size - The image size and its source (undefined when unknown).
 * @param error - Why the size could not be determined (offline etc.).
 * @returns The check row.
 */
export function freeDiskCheck(freeGb: number | undefined, size?: ImageSize, error?: string): Check {
  if (size === undefined) {
    return {
      label: 'free disk',
      ok: false,
      required: false,
      unknown: true,
      hint: error
        ? `could not determine the image size: ${shortError(error)}`
        : 'could not determine the image size — no image in the catalog',
    };
  }
  const neededGb = size.bytes / 1e9;
  const source = size.source === 'local' ? 'pulled image footprint' : 'GHCR image download';
  return {
    label: 'free disk',
    ok: freeGb !== undefined && freeGb >= neededGb,
    required: true,
    hint:
      freeGb === undefined
        ? `could not determine free disk — needs ${neededGb.toFixed(0)} GB (${source})`
        : `free ${freeGb.toFixed(0)} GB vs ${neededGb.toFixed(0)} GB needed (${source})`,
  };
}

/** A registry error detail shortened for the table hint (the full text
 *  is already on stderr when a retry warns). */
function shortError(error: string): string {
  const text = error.replace(/^Error:\s*/, '');
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** The platform's real image size: the measured footprint when a catalog
 *  image is pulled, otherwise the published GHCR download size (the
 *  largest image wins, matching the old disk_size semantics).
 *
 * @param platform - The platform to size.
 * @returns The size (undefined when undeterminable) and the failure
 *   detail for the hint.
 */
async function platformImageSize(
  platform: Platform,
): Promise<{ size?: ImageSize; error?: string }> {
  const images = catalogImagesFor(platform);
  if (images.length === 0) {
    return {};
  }
  const owner = await resolveOwner();
  const settled = await Promise.allSettled(
    images.map((image) =>
      resolveImageSize(platform, image.name, { ref: registryRef(image.name, 'latest', owner) }),
    ),
  );
  let size: ImageSize | undefined;
  let error: string | undefined;
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value && (!size || result.value.bytes > size.bytes)) {
        size = result.value;
      }
    } else {
      error ??= errorDetail(result.reason);
    }
  }
  return { size, error };
}

/** The platform's catalog images (empty when the catalog cannot be
 *  read). */
function catalogImagesFor(platform: Platform): CatalogImage[] {
  try {
    return listImages().filter((image) => image.platform === platform);
  } catch {
    return [];
  }
}

function macosChecks(): Check[] {
  return [
    {
      label: 'tart',
      ok: commandExists('tart'),
      required: true,
      hint: 'brew install cirruslabs/cli/tart',
    },
  ];
}

function qemuChecks(): Check[] {
  return [
    {
      label: 'qemu',
      ok: commandExists('qemu-system-aarch64'),
      required: true,
      hint: 'brew install qemu',
    },
    {
      label: 'qemu-img',
      ok: commandExists('qemu-img'),
      required: true,
      hint: 'brew install qemu',
    },
    { label: 'swtpm', ok: commandExists('swtpm'), required: true, hint: 'brew install swtpm' },
    {
      label: 'oras',
      ok: commandExists('oras'),
      required: true,
      hint: 'brew install oras — needed to pull images',
    },
  ];
}

function vmwareChecks(): Check[] {
  return [
    {
      label: 'vmrun',
      ok: findVmrun() !== undefined,
      required: true,
      hint: 'install VMware Fusion (free for personal use) or set FUSION_APP_PATH',
    },
    {
      label: 'oras',
      ok: commandExists('oras'),
      required: true,
      hint: 'brew install oras — needed to pull images',
    },
  ];
}

function freeDiskGb(): number | undefined {
  try {
    const s = statfsSync('/');
    return (s.bavail * s.bsize) / 1e9;
  } catch {
    return undefined;
  }
}
