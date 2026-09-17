// runners/macos.ts — the macOS backend (Phase 3 of the port, tart only):
// image select (pull with confirm) + working VM clone, boot with the
// recommended settings, and the flow hooks the framework calls. The
// step-3 bridges live in macos-bridges.ts, the summary in
// macos-summary.ts — this module is the backend wiring.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isAlive, killTree, sleep, spawnDetached } from '../lib/exec.js';
import { registryRef, resolveOwner } from '../lib/ghcr.js';
import { logger } from '../lib/logger.js';
import { paths } from '../lib/paths.js';
import { PLATFORM_DEFAULTS } from '../lib/platform.js';
import { confirmDefault } from '../lib/prompt.js';
import { clearCloneRecord } from '../lib/provenance.js';
import {
  cloneVm,
  deleteVm,
  dirArg,
  listVms,
  pullImage,
  setVm,
  stopVm,
  tartAvailable,
  tartRunArgs,
  tartSetArgs,
  vmExists,
  vmIp,
  vmState,
  waitForVmState,
} from '../lib/tart.js';
import { ensureUserSettings, restartOpenchamber } from '../settings/macos-copy.js';
import type { RunContext, RunState, SandboxBackend } from './framework.js';
import { ensureBridgeDir } from './bridges.js';
import { macosBridges } from './macos-bridges.js';
import { backfillMacosClone, recordMacosClone, recordMacosImagePull } from './macos-provenance.js';
import { printMacosSummary } from './macos-summary.js';
import { offerOpenInBrowser, waitForOpenchamber } from './openchamber.js';

/** The macOS backend — tart only (no data footprint; Tart owns the VM
 *  store, our logs live under the logs/state dir).
 */
export const macosBackend: SandboxBackend = {
  preflight: (context) => preflight(context),
  ensureImageAndVm: ensureImageAndVm,
  boot: boot,
  setupBridges: macosBridges,
  setupSettings: setupSettings,
  verifyOpenchamber: verifyOpenchamber,
  summarize: (context, state) => printMacosSummary(context, state),
  finish: finish,
};

/** The platform id of the macOS backend (provenance records). */
const PLATFORM = 'macos' as const;

async function preflight(context: RunContext): Promise<void> {
  if (!tartAvailable()) {
    logger.die("tart is not installed — run 'brew install cirruslabs/cli/tart' first.");
  }
  ensureBridgeDir();
  if (context.options.reset) {
    await teardownWorkingVm(context);
  }
}

/** `--reset`: stop + delete the working VM so the next step re-clones it
 *  fresh (a "start over" without touching the pristine image). */
async function teardownWorkingVm(context: RunContext): Promise<void> {
  const { instance } = context;
  if (!(await vmExists(instance))) {
    return;
  }
  if ((await vmState(instance)) === 'running') {
    await stopVm(instance);
    await waitForVmState(instance, 'stopped');
  }
  await deleteVm(instance);
  clearCloneRecord(PLATFORM, context.image, instance);
  logger.info(`Removed the working VM '${instance}' (--reset).`);
}

// --- step 1: image + working VM ---------------------------------------------

/** Resolves the source for `tart clone`: the local VM name when the pristine
 *  image was imported locally (older setups / Packer builds), otherwise the
 *  OCI reference actually staged in `tart list` (matched by
 *  `/<image>:latest` regardless of the owner — an already-pulled image is
 *  reused and no GHCR owner is needed to detect it), falling back to the
 *  pull reference for an image that is not present yet.
 *
 *  On current Tart versions, `tart pull` stages images in the local OCI
 *  store under their full registry reference (`ghcr.io/<owner>/<image>:
 *  latest`) — the bare short name never appears in `tart list`, and
 *  `tart clone` only accepts a VM name or a full reference.
 *
 * @internal — exported for the co-located unit tests; production goes
 * through cloneSource().
 * @param vms - The parsed `tart list` map (name/ref → state).
 * @param image - The pristine image name.
 * @param owner - The GHCR owner (used only for the not-present fallback).
 * @returns The source for `tart clone`.
 */
export function resolveCloneSource(vms: Map<string, string>, image: string, owner: string): string {
  if (vms.has(image)) {
    return image;
  }
  const staged = [...vms.keys()].find(
    (name) => name.startsWith('ghcr.io/') && name.endsWith(`/${image}:latest`),
  );
  return staged ?? registryRef(image, 'latest', owner);
}

/** The clone source for the pristine image, resolved from the live
 *  `tart list` state (see resolveCloneSource).
 *
 * @param context - The run context.
 * @returns The source for `tart clone`.
 */
async function cloneSource(context: RunContext): Promise<string> {
  const owner = await resolveOwner({ owner: context.options.owner, env: context.options.env });
  return resolveCloneSource(await listVms(), context.image, owner);
}

async function ensureImageAndVm(context: RunContext, state: RunState): Promise<void> {
  const { instance, image } = context;
  const yes = context.options.yes;
  if (await vmExists(instance)) {
    backfillMacosClone(context);
    logger.ok(`Working VM '${instance}' found (state: ${await vmState(instance)}).`);
    return;
  }
  let source = await cloneSource(context);
  if (await vmExists(source)) {
    logger.info(`Sandbox image '${image}' is present.`);
  } else {
    logger.info(`Sandbox image '${image}' is not pulled on this machine.`);
    if (!(await confirmDefault('Pull it now?', { default: 'y', yes }))) {
      logger.die("aborted — no sandbox image available. Run 'tart pull' manually when ready.");
    }
    await pullSandboxImage(context);
    // `tart pull` stages the image under its OCI reference only — recompute
    // the source so the clone uses it instead of the non-existent short name.
    source = await cloneSource(context);
  }
  if ((await vmState(source)) === 'running') {
    logger.die(`image VM '${source}' is running — stop it first: tart stop ${source}`);
  }
  const ask = `No working VM '${instance}' yet — clone it from the pristine image '${image}'?`;
  if (await confirmDefault(ask, { default: 'y', yes })) {
    logger.cmd(`tart clone ${source} ${instance}`);
    const res = await cloneVm(source, instance);
    if (res.code !== 0) {
      throw new Error(`tart clone failed:\n${res.stderr.trim()}`);
    }
    await recordMacosClone(context);
    state.created = true;
    logger.ok(`Cloned '${instance}' from '${image}'.`);
  } else {
    logger.die(
      `aborted — '${instance}' is required. Clone it manually with 'tart clone ${source} ${instance}'.`,
    );
  }
}

async function pullSandboxImage(context: RunContext): Promise<void> {
  const owner = await resolveOwner({ owner: context.options.owner, env: context.options.env });
  const ref = registryRef(context.image, 'latest', owner);
  const hint = PLATFORM_DEFAULTS[context.platform].downloadHint;
  logger.info(`Pulling ${ref} (one-time, ${hint} download)...`);
  try {
    await pullImage(ref);
  } catch {
    logger.die(
      'pull failed — check your network connection (public GHCR images pull without a login).',
    );
  }
  await recordMacosImagePull(context);
}

// --- step 2: boot -----------------------------------------------------------

async function boot(context: RunContext, state: RunState): Promise<void> {
  if ((await vmState(context.instance)) === 'running') {
    state.vmAlreadyRunning = true;
    const ask = `VM '${context.instance}' is already running — restart it?`;
    if (await confirmDefault(ask, { default: 'n', yes: context.options.yes })) {
      await stopAndWait(context);
      await sleep(1000); // let tart release the VM lock before running it again
      await launchVm(context, state);
    } else {
      logger.ok(`Keeping the running VM — skipping 'tart run'.`);
    }
    return;
  }
  if (state.created) {
    await applyRecommendedSettings(context);
  }
  await launchVm(context, state);
}

async function stopAndWait(context: RunContext): Promise<void> {
  logger.cmd(`tart stop ${context.instance}`);
  const stopped = await stopVm(context.instance);
  if (stopped.code !== 0) {
    logger.die(`'tart stop ${context.instance}' failed.`);
  }
  if (!(await waitForVmState(context.instance, 'stopped'))) {
    logger.die(`timed out waiting for '${context.instance}' to stop.`);
  }
  logger.ok(`VM '${context.instance}' is stopped.`);
}

async function applyRecommendedSettings(context: RunContext): Promise<void> {
  const args = tartSetArgs(context.instance, context.cpuCount, context.memoryMb);
  logger.cmd(`tart ${args.join(' ')}`);
  const res = await setVm(args);
  if (res.code !== 0) {
    throw new Error(`tart set failed:\n${res.stderr.trim()}`);
  }
  logger.ok(
    `Applied recommended settings: ${context.cpuCount} CPUs / ` +
      `${Math.round(context.memoryMb / 1024)} GB / 1280x800 display-refit.`,
  );
}

async function launchVm(context: RunContext, state: RunState): Promise<void> {
  const { workDir } = context;
  let shareArg: string | undefined;
  if (workDir && existsSync(workDir)) {
    shareArg = dirArg(context.mountName, workDir);
  } else if (workDir) {
    logger.warn(
      `work directory '${workDir}' does not exist — skipping the shared-directory mount.`,
    );
  }
  const args = tartRunArgs(context.instance, {
    headless: context.options.headless,
    dirArg: shareArg,
  });
  logger.cmd(`tart ${args.join(' ')}`);
  state.tartLog = join(paths.logs, `tart-${context.instance}.log`);
  if (context.options.foreground) {
    const child = spawn('tart', args, { stdio: 'inherit' });
    state.tartChild = child;
    state.tartPid = child.pid;
  } else {
    logger.info(`Running the VM in the background (output: ${state.tartLog}).`);
    state.tartPid = spawnDetached('tart', args, { logFile: state.tartLog });
  }
  await waitForBoot(context, state);
}

/** Polls `tart list` + the `tart run` process until the VM is up. */
async function waitForBoot(context: RunContext, state: RunState): Promise<void> {
  process.stdout.write('    Waiting for the VM to boot (up to 3 min)');
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (state.tartPid !== undefined && !isAlive(state.tartPid)) {
      process.stdout.write('\n');
      logger.die("'tart run' exited before the VM started.");
    }
    if ((await vmState(context.instance)) === 'running') {
      const ip = await vmIp(context.instance);
      state.vmIp = ip;
      process.stdout.write(` ${logger.color('green')}done${logger.reset()}\n`);
      logger.ok(ip ? `VM is running (IP: ${ip}).` : 'VM is running.');
      return;
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  process.stdout.write('\n');
  logger.die(`timed out waiting for '${context.instance}' to boot.`);
}

// --- step 4/5 hooks ---------------------------------------------------------

async function setupSettings(context: RunContext, state: RunState): Promise<void> {
  if (context.options.noSettings) {
    logger.info('Skipping user settings copy (--no-settings).');
    state.settings = 'skipped';
    return;
  }
  state.settings = await ensureUserSettings(
    context.instance,
    context.options.home,
    context.options.yes,
  );
  if (state.settings === 'copied') {
    await restartOpenchamber(context.instance, context.openchamberPort);
  }
}

async function verifyOpenchamber(context: RunContext, state: RunState): Promise<void> {
  let ip = state.vmIp;
  if (!ip) {
    ip = await vmIp(context.instance);
    state.vmIp = ip;
  }
  if (!ip) {
    logger.warn('OpenChamber: VM IP unavailable — cannot probe.');
    return;
  }
  state.openchamberUrl = `http://${ip}:${context.openchamberPort}`;
  state.openchamberUp = await waitForOpenchamber(state.openchamberUrl);
  if (state.openchamberUp) {
    await offerOpenInBrowser(state.openchamberUrl, context.options.yes);
  }
}

// --- finish: foreground wait + bridge cleanup --------------------------------

async function finish(context: RunContext, state: RunState): Promise<void> {
  if (!context.options.foreground) {
    return;
  }
  await waitForForegroundVm(context, state);
  // The VM stopped (or Cmd+C was pressed) — kill the bridges this run
  // started; in background mode (and for a bridge that was already up
  // from an earlier run) they stay up, outliving the CLI by design.
  await cleanupRunBridge(state.bridges.agent.pid, 'agent bridge');
  await cleanupRunBridge(state.bridges.docker.pid, 'Docker bridge');
}

/** @internal — kills one of this run's bridges. */
async function cleanupRunBridge(pid: number | undefined, label: string): Promise<void> {
  if (pid === undefined) {
    return;
  }
  await killTree(pid);
  logger.info(`Stopped the host ${label} (pid ${pid}).`);
}

async function waitForForegroundVm(context: RunContext, state: RunState): Promise<void> {
  const child = state.tartChild;
  if (!child) {
    return;
  }
  const exitCode = await new Promise<number | null>((resolve) => {
    const drain = (): void => {
      // keep the wait going — `tart run` received the same signal
    };
    process.on('SIGINT', drain);
    process.on('SIGTERM', drain);
    child.on('close', (code) => {
      process.removeListener('SIGINT', drain);
      process.removeListener('SIGTERM', drain);
      resolve(code);
    });
  });
  if (exitCode === 0) {
    logger.info(`VM '${context.instance}' has stopped.`);
  } else {
    logger.warn(`VM '${context.instance}' exited with an error (see tart output above).`);
  }
}
