// commands/status.ts — `agent-dev-env status [platform]`: live status of
// one or all platforms. New command (no shell equivalent): reports whether
// the default image is pulled, which sandbox instances exist (per
// instance: working state + running), and the provenance, per platform.
// Read-only and informational: missing tooling is reported, not fatal.
//
// Instance selection follows SANDBOX_VM (like run/stop/delete/sync):
// status reports the resolved instance, and when SANDBOX_VM is unset it
// additionally lists every instance with working state on the disk.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultImageFor, imageVersion, type CatalogImage } from '../lifecycle/catalog.js';
import { isAlive, readPidFile, run } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { imageRootDir, instanceDir, listInstances, vmwarePartsDir } from '../lib/paths.js';
import { readPartsRecord } from '../lib/parts.js';
import { PLATFORMS, type Platform } from '../lib/platform.js';
import { qemuImageReady, qemuPidFile, qemuStateDir, qemuWorkingDir } from '../lib/qemu.js';
import {
  CLONE_RECORD_MISSING,
  describeCloneRecord,
  describeImageRecord,
  readCloneRecord,
  readImageRecord,
} from '../lib/provenance.js';
import { listVms, tartAvailable, vmIp } from '../lib/tart.js';
import { findVmrun, listRunningVms } from '../lib/vmrun.js';
import { resolveInstance } from '../runners/options.js';

/** Prints the live status of one platform (or all platforms when none is
 *  given).
 *
 * @param platformArg - The platform to report on; all when omitted.
 * @returns Exit code: always 0 (status is informational).
 */
export async function statusCmd(platformArg?: Platform): Promise<number> {
  const targets: Platform[] = platformArg ? [platformArg] : [...PLATFORMS];
  for (const [i, platform] of targets.entries()) {
    if (i > 0) {
      logger.out('');
    }
    await printStatus(platform);
  }
  return 0;
}

/** Prints one platform's status. */
async function printStatus(platform: Platform): Promise<void> {
  logger.title(platform);

  let image: CatalogImage;
  try {
    image = defaultImageFor(platform);
  } catch (err) {
    logger.warn((err as Error).message);
    return;
  }

  let version = '?';
  try {
    version = imageVersion(image);
  } catch {
    // vars file without image_version — show '?' and let deploy/tag fail.
  }

  const details: string[] = [`image: ${image.name} (v${version})`];

  switch (platform) {
    case 'macos':
      await readMacosStatus(platform, image.name, details);
      break;
    case 'windows-qemu':
      await readQemuStatus(platform, image, details);
      break;
    case 'windows-vmware':
    case 'ubuntu-vmware':
      await readVmwareStatus(platform, image, details);
      break;
  }

  for (const line of details) {
    logger.info(line);
  }
}

/** The instance names to report for an image: the resolved one always
 *  first, then every instance with working state (only when SANDBOX_VM is
 *  unset — otherwise the resolved instance is the whole story).
 */
function reportTargets(platform: Platform, imageName: string): string[] {
  const resolved = resolveInstance();
  const onDisk = listInstances(platform, imageName);
  if ((process.env.SANDBOX_VM ?? '').trim() !== '') {
    return [resolved];
  }
  return [resolved, ...onDisk.filter((name) => name !== resolved)];
}

async function readMacosStatus(
  platform: Platform,
  imageName: string,
  details: string[],
): Promise<void> {
  if (!tartAvailable()) {
    details.push('tart: not installed (brew install cirruslabs/cli/tart)');
    return;
  }
  const vms = await listVms();

  const imageState = vms.get(imageName);
  details.push(imageState ? `image: pulled (${imageState})` : 'image: not pulled');
  const imageRecord = readImageRecord(platform, imageName);
  if (imageRecord) {
    details.push(`image source: ${describeImageRecord(imageRecord)}`);
  }

  for (const instance of reportTargets('macos', imageName)) {
    await detailMacosInstance(platform, vms, imageName, instance, details);
  }
}

/** One macos instance line: VM state (+ IP) and the clone source. */
async function detailMacosInstance(
  platform: Platform,
  vms: Map<string, string>,
  imageName: string,
  instance: string,
  details: string[],
): Promise<void> {
  const vmState = vms.get(instance);
  if (!vmState) {
    details.push(`VM: ${instance} — not created`);
    return;
  }
  if (vmState === 'running') {
    const ip = await vmIp(instance);
    details.push(`VM: ${instance} — running${ip ? ` (${ip})` : ''}`);
  } else {
    details.push(`VM: ${instance} — ${vmState}`);
  }
  const clone = readCloneRecord(platform, imageName, instance);
  details.push(`clone source: ${clone ? describeCloneRecord(clone) : CLONE_RECORD_MISSING}`);
}

async function readQemuStatus(
  platform: Platform,
  image: CatalogImage,
  details: string[],
): Promise<void> {
  const name = image.name;
  const stateDir = qemuStateDir(name);

  details.push(qemuImageReady(name) ? 'image: pulled' : 'image: not pulled');
  const imageRecord = readImageRecord(platform, name);
  if (imageRecord) {
    details.push(`image source: ${describeImageRecord(imageRecord)}`);
  }

  let sawAny = false;
  for (const instance of reportTargets(platform, name)) {
    sawAny = (await detailQemuInstance(name, instance, details)) || sawAny;
  }
  if (!sawAny) {
    details.push(`VM: ${name} — not created (no state at ${stateDir})`);
  }
}

/** One qemu instance line; returns true when the instance has state. */
async function detailQemuInstance(
  name: string,
  instance: string,
  details: string[],
): Promise<boolean> {
  const workingDir = qemuWorkingDir(name, instance);
  if (!existsSync(workingDir)) {
    details.push(`VM: ${name} (${instance}) — not created`);
    return false;
  }
  const pidFile = qemuPidFile(name, instance);
  let running = false;
  let pid: number | undefined;
  pid = readPidFile(pidFile);
  if (pid !== undefined) {
    running = isAlive(pid);
  } else {
    // A VM started without a pidfile (or a stale one): the overlay path
    // is unique to this sandbox — same fallback as the stop script.
    const pgrep = await run('pgrep', ['-f', `qemu-system-aarch64.*${workingDir}`]);
    running = pgrep.code === 0 && pgrep.stdout.trim() !== '';
  }
  details.push(
    running
      ? `VM: ${name} (${instance}) — running (qemu pid ${pid ?? '?'})`
      : `VM: ${name} (${instance}) — stopped`,
  );
  addCloneSourceLine('windows-qemu', name, instance, details);
  return true;
}

async function readVmwareStatus(
  platform: Platform,
  image: CatalogImage,
  details: string[],
): Promise<void> {
  const name = image.name;
  const stateDir = imageRootDir(platform, name);
  const partsDir = vmwarePartsDir(platform, name);
  const baseDir = join(stateDir, 'base');

  details.push(
    readPartsRecord(partsDir) || existsSync(baseDir) ? 'image: pulled' : 'image: not pulled',
  );
  const imageRecord = readImageRecord(platform, name);
  if (imageRecord) {
    details.push(`image source: ${describeImageRecord(imageRecord)}`);
  }

  let sawAny = false;
  for (const instance of reportTargets(platform, name)) {
    sawAny = (await detailVmwareInstance(platform, name, instance, details)) || sawAny;
  }
  if (!sawAny) {
    details.push(`VM: ${name} — not created (no state at ${stateDir})`);
  }
}

/** One vmware instance line; returns true when the instance has a vmx. */
async function detailVmwareInstance(
  platform: Platform,
  name: string,
  instance: string,
  details: string[],
): Promise<boolean> {
  const vmx = join(instanceDir(platform, name, instance), `${name}.vmx`);
  if (!existsSync(vmx)) {
    details.push(`VM: ${name} (${instance}) — not created`);
    return false;
  }

  const vmrun = findVmrun();
  if (!vmrun) {
    details.push('VM: state unknown — vmrun not found (VMware Fusion missing?)');
    return true;
  }
  let running = false;
  try {
    const runningVms = await listRunningVms({ vmrun });
    const wanted = normalizePath(vmx);
    running = runningVms.some((path) => normalizePath(path) === wanted);
  } catch (err) {
    details.push(`vmrun list failed: ${(err as Error).message}`);
    return true;
  }
  details.push(
    running ? `VM: ${name} (${instance}) — running` : `VM: ${name} (${instance}) — stopped`,
  );
  addCloneSourceLine(platform, name, instance, details);
  return true;
}

/** Appends the clone-source status line: the recorded provenance, or the
 *  "cloned before tracking" hint when the working VM exists without one.
 */
function addCloneSourceLine(
  platform: Platform,
  imageName: string,
  instance: string,
  details: string[],
): void {
  const clone = readCloneRecord(platform, imageName, instance);
  if (clone) {
    details.push(`clone source: ${describeCloneRecord(clone)}`);
  } else {
    details.push(`clone source: ${CLONE_RECORD_MISSING}`);
  }
}

function normalizePath(p: string): string {
  return p.replace(/\/+/g, '/');
}
