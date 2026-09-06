// build-qemu.ts — the windows-qemu build flow: the port of
// images/windows-arm64-qemu/build.sh (ISO + virtio-win staging, swtpm,
// the watchdog, the packer pipeline with qemu-with-tpm.sh, zstd
// compression). Failures throw; a kink in the shell flow is the bare
// start_watchdog call (a missing vncdotool aborts the build under set
// -e) — the CLI warn+skips like the VMware wrappers do.

import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isAlive, readPidFile, run, runChecked, sleep } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { type CatalogImage } from './catalog.js';
import {
  announceBuild,
  type BuildContext,
  buildDirLayout,
  type BuildDirLayout,
  ensureCacheDir,
  materializeContext,
  qemuImgCompressArgs,
  requireAppleSilicon,
  requireCommands,
  requireWindowsIso,
  runPackerBuild,
  runPackerFmtCheck,
  runPackerInit,
  stringVar,
  swtpmArgs,
  verifyIsoSha256,
} from './build-shared.js';
import { startBuildWatchdog, stopBuildWatchdog } from './build-watchdog.js';
import type { BuildFlowOptions } from './build-macos.js';

/** The virtio drivers staged into the unattend CD (viostor = boot disk,
 *  vioscsi belt-and-braces, NetKVM = the NIC, viogpudo = display). */
const WINPE_DRIVERS = ['viostor', 'vioscsi', 'NetKVM', 'viogpudo'] as const;

/** Builds a windows-qemu image.
 *
 * @param image - The catalog image.
 * @param options - Force/watchdog overrides.
 */
export async function buildQemuImage(
  image: CatalogImage,
  options: BuildFlowOptions,
): Promise<void> {
  requireAppleSilicon('the Windows image can only be built on Apple Silicon (QEMU + HVF).');
  requireCommands([
    ['packer', 'brew install packer'],
    ['qemu-system-aarch64', 'brew install qemu'],
    ['qemu-img', 'brew install qemu'],
    ['swtpm', 'brew install swtpm'],
    ['curl', 'comes with macOS'],
    ['hdiutil', 'comes with macOS'],
    ['xmllint', 'comes with macOS'],
  ]);
  const dirs = buildDirLayout('windows-qemu');
  ensureCacheDir(dirs.cache);
  const context = materializeContext(image);
  announceBuild(image, context);

  const { winIso, virtioIso } = await prepareQemuInputs(image, dirs);
  const swtpm = await startSwtpm(dirs.cache);
  await runQemuPacker(image, options, dirs, context, { winIso, virtioIso, swtpm });
  await compressQemuOutput(dirs.output, image.name);
}

/** Windows ISO + virtio-win.iso verification and driver staging. */
async function prepareQemuInputs(
  image: CatalogImage,
  dirs: BuildDirLayout,
): Promise<{ winIso: string; virtioIso: string }> {
  const winIso = requireWindowsIso(image);
  await verifyIsoSha256(winIso, stringVar(image, 'iso_sha256'), 'Windows ISO', image.varsFile);
  const virtioIso = await requireVirtioWinIso(image, dirs.cache);
  await stageVirtioDrivers(virtioIso, dirs.staging);
  return { winIso, virtioIso };
}

/** The watchdog + packer pipeline (xmllint/init/fmt/build), with the
 *  watchdog and swtpm torn down afterwards. */
async function runQemuPacker(
  image: CatalogImage,
  options: BuildFlowOptions,
  dirs: BuildDirLayout,
  context: BuildContext,
  inputs: { winIso: string; virtioIso: string; swtpm: { pidFile: string; sock: string } },
): Promise<void> {
  let watchdogPid: number | undefined;
  if (options.watchdog !== false) {
    watchdogPid = await startBuildWatchdog({ cacheDir: dirs.cache });
  }
  try {
    await runXmllint(context.platformDir);
    await runPackerInit(context.templateFile);
    await runPackerFmtCheck(context.platformDir);
    await runPackerBuild({
      platformDir: context.platformDir,
      templateFile: context.templateFile,
      varsFile: image.varsFile,
      buildDir: dirs.build,
      force: options.force,
      env: {
        SWTPM_SOCK: inputs.swtpm.sock,
        VIRTIO_WIN_ISO_PATH: inputs.virtioIso,
        QEMU_WITH_TPM_LOG: join(dirs.cache, 'qemu-with-tpm.cmd.log'),
        PKR_VAR_iso_path: inputs.winIso,
        PKR_VAR_virtio_win_iso_path: inputs.virtioIso,
        PKR_VAR_qemu_binary: join(context.platformDir, 'qemu-with-tpm.sh'),
      },
    });
  } finally {
    await stopBuildWatchdog(watchdogPid);
    await stopSwtpm(inputs.swtpm.pidFile);
  }
}

/** Resolution of virtio-win.iso: the env override, or a cached download
 *  from the vars file's virtio_win_url.
 *
 * @param image - The catalog image.
 * @param cacheDir - The build cache dir.
 * @returns The virtio-win.iso path.
 */
async function requireVirtioWinIso(image: CatalogImage, cacheDir: string): Promise<string> {
  const cachedPath = join(cacheDir, 'virtio-win.iso');
  const path = process.env.VIRTIO_WIN_ISO_PATH ?? cachedPath;
  if (!process.env.VIRTIO_WIN_ISO_PATH) {
    logger.step('VIRTIO_WIN_ISO_PATH unset — downloading virtio-win.iso');
    if (existsSync(cachedPath)) {
      logger.info(`already cached: ${cachedPath}`);
    } else {
      const url = stringVar(image, 'virtio_win_url');
      if (!url) {
        throw new Error(`virtio_win_url is empty in ${image.varsFile}`);
      }
      await runChecked('curl', ['-fSL', '-o', cachedPath, url], { stream: true });
    }
    await verifyIsoSha256(
      cachedPath,
      stringVar(image, 'virtio_win_sha256') ?? '',
      'virtio-win.iso',
      image.varsFile,
      `Delete ${cachedPath} and rebuild, or update virtio_win_sha256 in ${image.varsFile}.`,
    );
  }
  if (!existsSync(path)) {
    throw new Error(`VIRTIO_WIN_ISO_PATH points to a file that does not exist:\n       ${path}`);
  }
  return path;
}

/** Extracts the ARM64 drivers from virtio-win.iso (hdiutil) into the
 *  staging dir; a failed/missing build still detaches the mount.
 *
 * @param virtioIso - The virtio-win.iso path.
 * @param stagingDir - The staging dir.
 */
async function stageVirtioDrivers(virtioIso: string, stagingDir: string): Promise<void> {
  const mountDir = mkdtempSync(join(tmpdir(), 'agent-dev-env-virtio-win.'));
  const missing: string[] = [];
  logger.step(`mounting ${basename(virtioIso)}`);
  try {
    await runChecked('hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mountDir,
      virtioIso,
    ]);
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    for (const driver of WINPE_DRIVERS) {
      const src = join(mountDir, driver, 'w11', 'ARM64');
      if (!existsSync(src)) {
        missing.push(driver);
        continue;
      }
      cpSync(src, join(stagingDir, driver), { recursive: true });
    }
  } finally {
    await run('hdiutil', ['detach', mountDir, '-quiet']);
    rmSync(mountDir, { recursive: true, force: true });
  }
  if (missing.length > 0) {
    throw new Error(
      'ARM64 driver tree missing from virtio-win.iso for:\n' +
        `       ${missing.join(' ')}\n` +
        '       Expected <driver>/w11/ARM64/ to exist. Your virtio-win.iso\n' +
        '       may pre-date 0.1.240 (the first release with ARM64 builds).',
    );
  }
}

/** Runs swtpm as a daemon and waits for its Unix socket. */
async function startSwtpm(cacheDir: string): Promise<{ pidFile: string; sock: string }> {
  const swtpmDir = join(cacheDir, 'swtpm');
  const sock = join(swtpmDir, 'sock');
  const pidFile = join(swtpmDir, 'pid');
  mkdirSync(swtpmDir, { recursive: true });
  rmSync(sock, { force: true });
  rmSync(pidFile, { force: true });
  rmSync(join(swtpmDir, 'tpm2-00.permall'), { recursive: true, force: true });
  logger.step('starting swtpm (TPM 2.0 emulator)');
  await runChecked('swtpm', swtpmArgs(swtpmDir, sock, pidFile));
  await sleep(1000);
  if (!existsSync(sock)) {
    throw new Error(`swtpm socket ${sock} did not appear.\n       Check ${swtpmDir}/log.`);
  }
  return { pidFile, sock };
}

/** Kills swtpm by its pid file and removes the pid file. */
async function stopSwtpm(pidFile: string): Promise<void> {
  const pid = readPidFile(pidFile);
  if (pid !== undefined && isAlive(pid)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  rmSync(pidFile, { force: true });
}

/** zstd-compresses the built qcow2 and prints its info lines. */
async function compressQemuOutput(outputDir: string, imageName: string): Promise<void> {
  const output = join(outputDir, `${imageName}.qcow2`);
  if (!existsSync(output)) {
    throw new Error(`build produced no ${output}`);
  }
  logger.step(`compressing ${output} (zstd)`);
  await runChecked('qemu-img', qemuImgCompressArgs(output));
  renameSync(`${output}.tmp`, output);
  const info = await run('qemu-img', ['info', output]);
  for (const line of info.stdout.split('\n')) {
    if (/virtual size|disk size/.test(line)) {
      logger.info(line);
    }
  }
  logger.ok(`Done: ${output}`);
}

/** `xmllint --noout` on the unattend seed (catches XML typos early). */
async function runXmllint(platformDir: string): Promise<void> {
  logger.step('xmllint autounattend.xml');
  await runChecked('xmllint', ['--noout', join(platformDir, 'autounattend.xml')]);
}
