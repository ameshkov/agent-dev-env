// commands/run.ts — `agent-dev-env run <platform>`: resolve the options
// (flags > SANDBOX_* env > platform defaults), pick the backend, run the
// shared flow (runners/framework.ts). Phase 3 shipped the macOS backend,
// Phase 4 the Ubuntu VMware backend, Phase 5 the Windows VMware backend,
// Phase 6 the Windows QEMU backend — all four platforms are green.

import { logger } from '../lib/logger.js';
import type { Platform } from '../lib/platform.js';
import { runSandbox, type RunContext } from '../runners/framework.js';
import { macosBackend } from '../runners/macos.js';
import { resolveRunOptions, type RunFlags } from '../runners/options.js';
import { ubuntuBackend } from '../runners/ubuntu.js';
import { windowsBackend } from '../runners/windows.js';
import { windowsQemuBackend } from '../runners/windows-qemu.js';

/** Runs a sandbox VM platform.
 *
 * @param platform - The platform to run.
 * @param flags - The `run` command flags.
 * @returns The process exit code.
 */
export async function runCmd(platform: Platform, flags: RunFlags): Promise<number> {
  const options = resolveRunOptions(platform, flags);
  const context = buildContext(options);
  const title =
    platform === 'macos'
      ? `macOS sandbox: ${context.instance} (image: ${context.image}, ` +
        `${options.headless ? 'headless' : 'gui'} mode)`
      : platform === 'windows-vmware'
        ? `Windows VMware sandbox: ${context.instance} (image: ${context.image})`
        : platform === 'windows-qemu'
          ? `Windows QEMU sandbox: ${context.instance} (image: ${context.image})`
          : `Ubuntu VMware sandbox: ${context.instance} (image: ${context.image})`;
  logger.title(title);
  const backend =
    platform === 'macos'
      ? macosBackend
      : platform === 'windows-vmware'
        ? windowsBackend
        : platform === 'windows-qemu'
          ? windowsQemuBackend
          : ubuntuBackend;
  await runSandbox(backend, context);
  return 0;
}

/** @internal — folds the resolved options into the runner context (the
 *  guest mount path is the per-platform convention: Tart's
 *  /Volumes/My Shared Files/ on macOS, /mnt/hgfs/work on VMware). */
export function buildContext(options: ReturnType<typeof resolveRunOptions>): RunContext {
  const guestMount =
    options.platform === 'macos'
      ? `/Volumes/My Shared Files/${options.mountName}`
      : '/mnt/hgfs/work';
  return {
    platform: options.platform,
    options,
    instance: options.instance,
    image: options.image,
    workDir: options.workDir,
    mountName: options.mountName,
    guestMount,
    agentPort: options.agentPort,
    dockerPort: options.dockerPort,
    openchamberPort: options.openchamberPort,
    sshPort: options.sshPort,
    rdpPort: options.rdpPort,
    winrmPort: options.winrmPort,
    cpuCount: options.cpuCount,
    memoryMb: options.memoryMb,
  };
}
