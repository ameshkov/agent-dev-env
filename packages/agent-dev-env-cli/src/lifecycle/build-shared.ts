// build-shared.ts — helpers shared by the per-platform build flows (the
// port of scripts/build.sh plus the three images/*/build.sh wrappers):
// host prereqs, the build-dir layout, ISO hash verification, the
// materialized Packer context, the packer pipeline (init / fmt -check /
// build), and the pure arg builders the wrappers inline (swtpm,
// qemu-img, unzip, the Ubuntu seed + grub command).
//
// Failures throw (the CLI's top level turns them into die()); helpers
// keep the shell's exact error wording.

import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { commandExists, run, runChecked } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { buildDir, paths } from '../lib/paths.js';
import type { Platform } from '../lib/platform.js';
import { upgradeVmHardware, vmwareHwVersion } from '../lib/vmrun.js';
import { type CatalogImage, varsFor } from './catalog.js';

/** The per-platform build directories under <data>/build/<platform>.
 *
 *  Note: output/ is never pre-created — the packer plugins refuse an
 *  existing output directory (use `--force` to rebuild over an old
 *  artifact).
 */
export interface BuildDirLayout {
  /** <data>/build/<platform> — the per-platform build root. */
  build: string;
  /** <build>/output — Packer's output_directory (built artifacts). */
  output: string;
  /** <build>/packer_cache — ISOs, swtpm state, watchdog frames/logs. */
  cache: string;
  /** <build>/drivers/staging — staged unattend-CD drivers. */
  staging: string;
}

/** The build dirs for a platform.
 *
 * @param platform - The platform id.
 * @returns The layout (build/output/cache/staging paths).
 */
export function buildDirLayout(platform: Platform): BuildDirLayout {
  const build = buildDir(platform);
  return {
    build,
    output: join(build, 'output'),
    cache: join(build, 'packer_cache'),
    staging: join(build, 'drivers', 'staging'),
  };
}

/** Host check: macOS Apple Silicon (QEMU/VMware cannot virtualize ARM64
 *  guests on Intel Macs).
 *
 * @returns True on an Apple Silicon Mac.
 */
function hostIsAppleSilicon(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

/** Dies with the platform's message when the host is not Apple Silicon.
 *
 * @param message - The platform-specific error message.
 */
export function requireAppleSilicon(message: string): void {
  if (!hostIsAppleSilicon()) {
    throw new Error(message);
  }
}

/** `command -v` check with the shell's install hint.
 *
 * @param command - The command name.
 * @param hint - The install hint (brew install … / comes with macOS).
 */
export function requireCmd(command: string, hint: string): void {
  if (!commandExists(command)) {
    throw new Error(
      `required command '${command}' not found on PATH.\n       Install with: ${hint}`,
    );
  }
}

/** Runs requireCmd for each [command, hint] pair.
 *
 * @param checks - The command/hint pairs to check.
 */
export function requireCommands(checks: Array<[string, string]>): void {
  for (const [command, hint] of checks) {
    requireCmd(command, hint);
  }
}

/** Reads a quoted-string variable from the image's vars file.
 *
 * @param image - The catalog image.
 * @param name - The variable name.
 * @returns The value, or undefined when absent/not a string.
 */
export function stringVar(image: CatalogImage, name: string): string | undefined {
  const value = varsFor(image)[name];
  return typeof value === 'string' ? value : undefined;
}

/** @internal — test-only export of the digest normalizer.
 *
 * @param raw - The digest as written.
 * @returns The normalized digest (lowercase, no whitespace).
 */
export function normalizeSha(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, '');
}

/** SHA256 of a file (shasum -a 256), normalized.
 *
 * @param file - The file to hash.
 * @returns The lowercase hex digest.
 */
async function sha256Of(file: string): Promise<string> {
  const res = await run('shasum', ['-a', '256', file]);
  if (res.code !== 0) {
    throw new Error(`shasum failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return normalizeSha(res.stdout.split(/\s+/)[0] ?? '');
}

/** Verifies a file against its vars-file sha256 (warns and skips when the
 *  expected digest is empty, matching the wrappers' behavior).
 *
 * @param file - The file to verify.
 * @param expected - The expected digest (empty = skip).
 * @param label - The digest context label (e.g. "Windows ISO").
 * @param varsFile - The vars file (for the error message).
 * @param failureNote - Optional custom failure hint.
 */
export async function verifyIsoSha256(
  file: string,
  expected: string | undefined,
  label: string,
  varsFile: string,
  failureNote?: string,
): Promise<void> {
  logger.step(`verifying SHA256 of ${basename(file)}`);
  const want = normalizeSha(expected ?? '');
  if (!want) {
    logger.warn(`iso_sha256 is empty in ${varsFile} — skipping ISO verification.`);
    return;
  }
  const got = await sha256Of(file);
  if (got !== want) {
    const note = failureNote ?? `Re-download the ISO or update iso_sha256 in ${varsFile}.`;
    throw new Error(
      `SHA256 mismatch for the ${label}.\n` + `  expected: ${want}\n  actual:   ${got}\n  ${note}`,
    );
  }
}

/** The materialized packer build context. */
export interface BuildContext {
  /** <data>/build-context/<platform-dir> — the copied platform dir. */
  platformDir: string;
  /** The platform's Packer template (first *.pkr.hcl). */
  templateFile: string;
}

/** Copies the image's platform dir into <data>/build-context/ so the
 *  packed context is writable and self-contained (npm installs cannot
 *  run builds from the read-only package snapshot), chmod'ing the
 *  qemu-with-tpm.sh wrapper on demand.
 *
 * @param image - The catalog image.
 * @param options - data-root override (tests).
 * @returns The materialized context (platform dir + template).
 */
export function materializeContext(
  image: CatalogImage,
  options: { dataRoot?: string } = {},
): BuildContext {
  const platformDir = dirname(dirname(image.varsFile));
  const contextRoot = join(options.dataRoot ?? paths.data, 'build-context', basename(platformDir));
  rmSync(contextRoot, { recursive: true, force: true });
  cpSync(platformDir, contextRoot, { recursive: true });
  chmodQemuWrapper(contextRoot);
  return { platformDir: contextRoot, templateFile: findTemplateFile(contextRoot) };
}

/** chmod +x the qemu-with-tpm.sh wrapper (packer execs it as the qemu
 *  binary; a copied context may lose the mode).
 *
 * @param contextRoot - The materialized platform dir.
 */
function chmodQemuWrapper(contextRoot: string): void {
  const qemu = join(contextRoot, 'qemu-with-tpm.sh');
  if (existsSync(qemu)) {
    chmodSync(qemu, 0o755);
  }
}

/** @internal — the first *.pkr.hcl template in the platform dir
 *  (test-only export; also used by materializeContext).
 *
 * @param platformDir - The platform dir.
 * @returns The template path.
 * @throws Error when no template exists (shell parity).
 */
export function findTemplateFile(platformDir: string): string {
  const templates = readdirSync(platformDir)
    .filter((entry) => entry.endsWith('.pkr.hcl'))
    .sort();
  if (templates.length === 0) {
    throw new Error(`No Packer template (*.pkr.hcl) found in ${platformDir}`);
  }
  return join(platformDir, templates[0]);
}

/** Logs the legacy per-image build header.
 *
 * @param image - The image being built.
 * @param context - The materialized context.
 */
export function announceBuild(image: CatalogImage, context: BuildContext): void {
  logger.title(`Building image: ${image.name}`);
  logger.info(`Using template: ${context.templateFile}`);
  logger.info(`Using vars: ${image.varsFile}`);
}

/** `packer init <template>` (installs required plugins).
 *
 * @param templateFile - The template to init.
 */
export async function runPackerInit(templateFile: string): Promise<void> {
  logger.step('packer init');
  await runChecked('packer', ['init', templateFile], { stream: true });
}

/** `packer fmt -check` — warns (does not fail) when formatting differs.
 *
 * @param platformDir - The dir to format-check.
 */
export async function runPackerFmtCheck(platformDir: string): Promise<void> {
  logger.step('packer fmt -check');
  const res = await run('packer', ['fmt', '-check', platformDir]);
  if (res.code !== 0) {
    logger.warn(`'packer fmt' would change formatting. Run 'packer fmt ${platformDir}' to fix.`);
  }
}

/** The packer build invocation options. */
export interface PackerBuildOptions {
  /** Cwd for the build (template-relative paths resolve here). */
  platformDir: string;
  templateFile: string;
  varsFile: string;
  /** Passed as `-var build_dir=…` (wrapper platforms only). */
  buildDir?: string;
  /** Add `-force` (rebuild over an old artifact). */
  force?: boolean;
  /** Extra env for the packer child (PKR_VAR_*, SWTPM_SOCK, ...). */
  env?: Record<string, string | undefined>;
}

/** `packer build [-force] [-var build_dir=…] -var-file=… <template>`.
 *
 * @param options - The build options.
 */
export async function runPackerBuild(options: PackerBuildOptions): Promise<void> {
  logger.step('packer build');
  const args = ['build'];
  if (options.force) {
    args.push('-force');
  }
  if (options.buildDir) {
    args.push('-var', `build_dir=${options.buildDir}`);
  }
  args.push('-var-file', options.varsFile, options.templateFile);
  await runChecked('packer', args, {
    cwd: options.platformDir,
    env: options.env,
    stream: true,
  });
}

/** The human size of a path (`du -sh`).
 *
 * @param path - The path to measure.
 * @returns The size string (e.g. "12G"), or '' when du fails.
 */
export async function duHuman(path: string): Promise<string> {
  const res = await run('du', ['-sh', path]);
  if (res.code !== 0) {
    return '';
  }
  return res.stdout.trim().split(/\s+/)[0] ?? '';
}

/** swtpm invocation (TPM 2.0 emulator, Unix socket control).
 *
 * @param tpmDir - The tpmstate dir.
 * @param sockPath - The control socket path.
 * @param pidFile - The pid file swtpm writes.
 * @returns The swtpm argv.
 */
export function swtpmArgs(tpmDir: string, sockPath: string, pidFile: string): string[] {
  return [
    'socket',
    '--tpmstate',
    `dir=${tpmDir}`,
    '--ctrl',
    `type=unixio,path=${sockPath}`,
    '--log',
    `file=${join(tpmDir, 'log')},level=20`,
    '--pid',
    `file=${pidFile}`,
    '--tpm2',
    '--daemon',
  ];
}

/** qemu-img zstd conversion of the built qcow2.
 *
 * @param output - The qcow2 to compress.
 * @returns The qemu-img argv (tmp output, renamed by the caller).
 */
export function qemuImgCompressArgs(output: string): string[] {
  return ['convert', '-c', '-O', 'qcow2', '-o', 'compression_type=zstd', output, `${output}.tmp`];
}

/** The vmxnet3 ARM64 driver extraction (flat, at the CD root).
 *
 * @param driversZip - Fusion's drivers-arm64.zip.
 * @param stagingDir - The staging dir.
 * @returns The unzip argv.
 */
export function unzipVmxnet3Args(driversZip: string, stagingDir: string): string[] {
  return [
    '-jo',
    driversZip,
    'vmxnet3/Win10_1709/ARM64/vmxnet3.cat',
    'vmxnet3/Win10_1709/ARM64/vmxnet3.inf',
    'vmxnet3/Win10_1709/ARM64/vmxnet3.sys',
    '-d',
    stagingDir,
  ];
}

/** The vmnet8 NAT subnet from Fusion's dhcpd.conf
 *  (`subnet x.y.z.0 netmask …`).
 *
 * @param content - The dhcpd.conf content.
 * @returns The subnet, or undefined when not found.
 */
export function vmnet8SubnetFromDhcpConf(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const match = line.match(/^subnet ([0-9.]+) netmask/);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** The grub autoinstall command the watchdog types (WATCH_BUILD_BOOT_CMD;
 *  `\;` escapes the grub command splitter).
 *
 * @param natHost - The vmnet8 host address (x.y.z.1).
 * @param seedPort - The seed server port.
 * @returns The multi-line grub command.
 */
export function watchdogBootCommand(natHost: string, seedPort: number): string {
  return (
    `linux /casper/vmlinuz autoinstall ds=nocloud-net\\;s=http://${natHost}:${seedPort}/ ---\n` +
    'initrd /casper/initrd\n' +
    'boot'
  );
}

/** Ensures the cache dir exists (never the output dir — packer owns it).
 *
 * @param cacheDir - The per-platform packer_cache dir.
 */
export function ensureCacheDir(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
}

/** The bring-your-own Windows ISO (WINDOWS_ISO_PATH).
 *
 * @param image - The catalog image (vars file for the error message).
 * @returns The ISO path.
 */
export function requireWindowsIso(image: CatalogImage): string {
  const winIso = process.env.WINDOWS_ISO_PATH;
  if (!winIso) {
    throw new Error(
      'WINDOWS_ISO_PATH is not set.\n' +
        '       Download the Windows 11 ARM64 ISO from\n' +
        '       https://www.microsoft.com/software-download/windows11arm64,\n' +
        '       then set WINDOWS_ISO_PATH to its absolute path.\n' +
        '       Paste the SHA256 from the download page into iso_sha256 in\n' +
        `       ${image.varsFile} to enable integrity verification.`,
    );
  }
  if (!existsSync(winIso)) {
    throw new Error(`WINDOWS_ISO_PATH points to a file that does not exist:\n       ${winIso}`);
  }
  return winIso;
}

/** Upgrades a built vmx to the host Fusion's hardware version (vmrun
 *  upgradevm never exits — the 180 s cap lives in upgradeVmHardware).
 *
 * @param vmx - The built vmx.
 * @param fusionPath - The Fusion app path (vmrun resolution).
 */
export async function upgradeArtifactHardware(vmx: string, fusionPath: string): Promise<void> {
  const env = { FUSION_APP_PATH: fusionPath };
  const before = vmwareHwVersion(vmx);
  let after: string | undefined;
  try {
    after = await upgradeVmHardware(vmx, { env });
  } catch (err) {
    logger.warn(
      `${(err as Error).message} — cannot upgrade the build output; a GUI start may prompt once.`,
    );
    return;
  }
  if (before && after && after !== before) {
    logger.step(`build output upgraded to hardware version ${after}`);
  } else {
    logger.step(`build output hardware version: ${after ?? 'unknown'}`);
  }
}

/** `du -sh` of the build output dir (the legacy "==> build output" log).
 *
 * @param outputDir - The output dir to report.
 */
export async function reportOutputDir(outputDir: string): Promise<void> {
  logger.step('build output');
  const size = await duHuman(outputDir);
  if (size) {
    logger.info(`${outputDir} (${size})`);
  }
}
