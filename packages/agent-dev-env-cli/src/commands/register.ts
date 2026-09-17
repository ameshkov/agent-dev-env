// commands/register.ts — the commander surface. Splitting the CLI into
// small register functions keeps every function under the oxlint
// max-lines-per-function gate (mirrors src/cli/register-commands.ts in
// ameshkov/mcp-compress-router).

import type { Command } from 'commander';
import { deleteCmd } from './delete.js';
import { doctorCmd } from './doctor.js';
import { listCmd } from './list.js';
import { runCmd } from './run.js';
import { statusCmd } from './status.js';
import { stopCmd } from './stop.js';
import { syncCmd } from './sync.js';
import { buildCmd } from '../lifecycle/build.js';
import { listImages, type CatalogImage } from '../lifecycle/catalog.js';
import { deployCmd } from '../lifecycle/deploy.js';
import { tagCmd } from '../lifecycle/tag.js';
import { watchBuildCmd } from '../lifecycle/watch-build.js';
import { logger } from '../lib/logger.js';
import { isPlatform, type Platform } from '../lib/platform.js';

const PLATFORM_CHOICE = 'macos|windows-qemu|windows-vmware|ubuntu-vmware';

/** Validates the platform argument, dying when unknown (same message shape
 *  as the shell's per-script usage errors). */
function parsePlatform(value: string): string {
  if (!isPlatform(value)) {
    logger.die(`unknown platform '${value}' (expected ${PLATFORM_CHOICE})`);
  }
  return value;
}

/** The catalog's images (repo checkout first, then the bundled snapshot)
 *  for the lifecycle help text; empty when none are discoverable.
 *
 * @returns The available images, or an empty list on catalog errors.
 */
function availableImages(): CatalogImage[] {
  try {
    return listImages();
  } catch {
    return [];
  }
}

/** The trailing help text for the image-taking lifecycle commands (build,
 *  deploy) listing the available images.
 *
 * @param images - The catalog images (empty when none were discovered).
 * @returns The help text (no trailing newline).
 */
function imagesHelpText(images: CatalogImage[]): string {
  if (images.length === 0) {
    return 'Available images: none discovered — run `agent-dev-env list`.';
  }
  return [
    'Available images:',
    ...images.map((image) => `  ${image.name} (${image.platform})`),
  ].join('\n');
}

/** Registers run/stop/delete/sync — the per-platform VM commands.
 *
 * @param program - The commander program to wire commands onto.
 */
export function registerVmCommands(program: Command): void {
  program
    .command('run')
    .alias('start')
    .argument('<platform>', PLATFORM_CHOICE, parsePlatform)
    .description(
      'Run (and wire up) a sandbox VM: macos | windows-qemu | windows-vmware | ubuntu-vmware',
    )
    .option('--headless', 'run without a window (tart run --no-graphics)')
    .option('--foreground', 'keep the terminal attached and block until the VM stops')
    .option('--no-agent', 'skip the SSH agent bridge setup')
    .option('--no-docker', 'skip the Docker engine bridge setup')
    .option('--no-settings', 'skip copying the host user settings into the guest')
    .option('--work-dir <path>', 'host dir to share into the guest (SANDBOX_WORK_DIR)')
    .option('--reset', 'delete the working VM first (fresh clone on this run)')
    .option('--image <image>', 'pristine image VM to pull/clone from (SANDBOX_IMAGE)')
    .option('--owner <owner>', 'GHCR owner for pulls (GHCR_OWNER)')
    .option('--yes', 'skip confirmation prompts')
    .action(async (platform: Platform, options: object) => {
      process.exitCode = await runCmd(platform, options as Parameters<typeof runCmd>[1]);
    });

  program
    .command('stop')
    .argument('<platform>', PLATFORM_CHOICE, parsePlatform)
    .description('Stop the sandbox VM and its host bridges')
    .action(async (platform: Platform) => {
      process.exitCode = await stopCmd(platform);
    });

  program
    .command('delete')
    .argument('<platform>', PLATFORM_CHOICE, parsePlatform)
    .option('--yes', 'do not ask for confirmation')
    .option('--pristine', 'also delete the pristine image (macOS) / shared image cache')
    .description('Delete the sandbox VM/state (pristine image too with --pristine)')
    .action(async (platform: Platform, options: object) => {
      process.exitCode = await deleteCmd(platform, options as Parameters<typeof deleteCmd>[1]);
    });

  program
    .command('sync')
    .argument('<platform>', PLATFORM_CHOICE, parsePlatform)
    .option('--yes', 'do not ask for confirmation')
    .description('Copy the host user settings into the guest')
    .action(async (platform: Platform, options: object) => {
      process.exitCode = await syncCmd(platform, options as Parameters<typeof syncCmd>[1]);
    });
}

/** Registers status/list — the live-info commands (implemented).
 *
 * @param program - The commander program to wire commands onto.
 */
export function registerStatusCommands(program: Command): void {
  program
    .command('status')
    .argument('[platform]', PLATFORM_CHOICE, parsePlatform)
    .description('Live status of one or all platforms')
    .action(async (platform?: Platform) => {
      process.exitCode = await statusCmd(platform);
    });

  program
    .command('list')
    .description('Bundled images: name, platform, image_version')
    .action(async () => {
      process.exitCode = await listCmd();
    });
}

/** Registers build/deploy/tag — the image lifecycle (Phase 7).
 *
 * @param program - The commander program to wire commands onto.
 */
export function registerLifecycleCommands(program: Command): void {
  const images = availableImages();
  program
    .command('build')
    .argument('[image...]', 'image names (no image = build all available images)')
    .option('--force', 'force a rebuild (packer -force)')
    .option('--no-watchdog', 'skip the VNC build watchdog')
    .description('Build sandbox images with Packer')
    .addHelpText('after', `\n${imagesHelpText(images)}`)
    .action(async (images: string[], options: { force?: boolean; watchdog?: boolean }) => {
      process.exitCode = await buildCmd(images, {
        force: options.force,
        watchdog: options.watchdog !== false,
      });
    });

  program
    .command('deploy')
    .argument('[image...]', 'image names (no image = deploy all available images)')
    .option('--owner <owner>', 'GHCR owner override')
    .description('Push locally built images to GHCR')
    .addHelpText('after', `\n${imagesHelpText(images)}`)
    .action(async (images: string[], options: { owner?: string }) => {
      process.exitCode = await deployCmd(images, { owner: options.owner });
    });

  program
    .command('tag')
    .argument('[image...]', 'image names')
    .option('--repo <path>', 'repo checkout to tag from (default: the current checkout)')
    .description('Create and push the git release tag')
    .action(async (images: string[], options: { repo?: string }) => {
      process.exitCode = await tagCmd(images, { repo: options.repo });
    });
}

/** Registers doctor — plus the hidden build watch-build command.
 *
 * @param program - The commander program to wire commands onto.
 */
export function registerDoctorCommands(program: Command): void {
  program
    .command('doctor')
    .option('--platform <platform>', PLATFORM_CHOICE, parsePlatform)
    .description('Prerequisite + disk check for one or all platforms')
    .action(async (options: { platform?: Platform }) => {
      process.exitCode = await doctorCmd({ platform: options.platform });
    });

  program
    .command('watch-build', { hidden: true })
    .argument('<vnc-port>', 'VNC port of the Packer build (builder pins 5901)')
    .argument('[outdir]', 'frame/output directory')
    .option('--no-ocr', 'skip the optional macOS OCR fallback')
    .description('Drive a VNC build watchdog against a build window')
    .action(async (vncPort: string, outdir: string | undefined, options: { noOcr?: boolean }) => {
      process.exitCode = await watchBuildCmd(Number.parseInt(vncPort, 10), outdir, {
        noOcr: options.noOcr,
      });
    });
}
