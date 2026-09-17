// commands/doctor.ts — `agent-dev-env doctor [--platform P]`: prereq table
// with install hints and a free-disk estimate (against the vars files'
// disk_size plus the build overhead — the ~70 GB macOS base image or the
// file-based builds' staging). Supersedes the scattered require_cmd
// blocks; read-only.
//
// Exit code: 1 when any required check fails, 0 otherwise. Optional
// (bridge/build-only) tooling is reported as such and does not fail the
// check.

import { statfsSync } from 'node:fs';
import { listImages, varsFor } from '../lifecycle/catalog.js';
import { commandExists } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { PLATFORM_DEFAULTS, PLATFORMS, type Platform } from '../lib/platform.js';
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
}

/** The free-disk overhead a build needs beyond the VM's `disk_size` and
 *  what it covers (the doctor hint): the macOS build pulls the ~70 GB
 *  Cirrus base image, the file-based builds stage the ISO + their
 *  intermediate artifacts.
 *
 * @param platform - The platform to size.
 * @returns The overhead in GB and the hint note.
 */
function buildOverhead(platform: Platform): { gb: number; note: string } {
  return platform === 'macos' ? { gb: 70, note: 'base image' } : { gb: 50, note: 'build overhead' };
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
  const statusText = (c: Check): string => (c.ok ? 'ok' : c.required ? 'missing' : 'optional');

  logger.out(`    ${'Requirement'.padEnd(width)}  Status  Hint`);
  for (const check of checks) {
    const status = statusText(check);
    const colored =
      status === 'ok'
        ? logger.color('green') + status + logger.reset()
        : logger.color('red') + status + logger.reset();
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
  return [...hostChecks(platform), ...platformChecks];
}

/** Checks shared by every platform: host, arch, free disk. */
function hostChecks(platform: Platform): Check[] {
  const needed = diskNeededGb(platform);
  const overhead = buildOverhead(platform);
  const free = freeDiskGb();
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
    {
      label: 'free disk',
      ok: free !== undefined && free >= needed,
      required: true,
      hint:
        free === undefined
          ? 'could not determine free disk'
          : `free ${free.toFixed(0)} GB vs ${needed.toFixed(0)} GB needed ` +
            `(disk_size + ~${overhead.gb} GB ${overhead.note})`,
    },
  ];
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

/** Largest disk_size among the platform's images + the build overhead. */
function diskNeededGb(platform: Platform): number {
  let maxSize = 0;
  try {
    const sizes = listImages()
      .filter((image) => image.platform === platform)
      .map((image) => varsFor(image).disk_size)
      .filter((size): size is number => typeof size === 'number');
    maxSize = sizes.length > 0 ? Math.max(...sizes) : 0;
  } catch {
    // no image in the catalog — fall back to the default estimate
  }
  return (maxSize || 100) + buildOverhead(platform).gb;
}

function freeDiskGb(): number | undefined {
  try {
    const s = statfsSync('/');
    return (s.bavail * s.bsize) / 1e9;
  } catch {
    return undefined;
  }
}
