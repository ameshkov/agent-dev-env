// commands/stop.ts — `agent-dev-env stop <platform>`: stop the VM
// ('tart stop' / 'vmrun stop' / the qemu+swtpm pidfiles) and kill the
// host bridges the runner left up (pidfile-managed bridge.js processes;
// a foreign listener on the port is left alone). macOS + Ubuntu VMware in
// Phases 3/4, Windows VMware in Phase 5, Windows QEMU in Phase 6.

import { existsSync } from 'node:fs';
import { run } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { workingVmxPath } from '../lib/paths.js';
import type { Platform } from '../lib/platform.js';
import { stopQemu, stopSwtpm } from '../lib/qemu.js';
import { stopVm, tartAvailable, vmExists, vmState, waitForVmState } from '../lib/tart.js';
import { findVmrun, isVmRunning, stopVmGraceful } from '../lib/vmrun.js';
import { stopHostBridge, type BridgeRole } from '../runners/bridges.js';
import { resolveRunOptions } from '../runners/options.js';

/** Stops a sandbox platform (VM + host bridges).
 *
 * @param platform - The platform to stop.
 * @returns The process exit code.
 */
export async function stopCmd(platform: Platform): Promise<number> {
  if (platform === 'macos') {
    await stopMacos();
    return 0;
  }
  if (platform === 'windows-qemu') {
    await stopQemuSandbox();
    return 0;
  }
  await stopVmware(platform);
  return 0;
}

/** The QEMU stop flow (the stop-windows-qemu-sandbox.sh port): qemu via
 *  the runner's qemu.pid (with the overlay-path pgrep fallback), swtpm
 *  (it otherwise holds the TPM state lock), then the host bridges.
 */
export async function stopQemuSandbox(): Promise<void> {
  const options = resolveRunOptions('windows-qemu');
  const image = options.image;
  const instance = options.instance;

  logger.title(`Stopping Windows QEMU sandbox: ${image} (${instance})`);

  logger.step('Stopping qemu');
  await stopQemu(image, instance);

  logger.step('Stopping swtpm');
  await stopSwtpm(image, instance);

  logger.step('Host bridges (SSH agent, Docker)');
  await stopBridgeForPort('ssh-agent', options.agentPort, instance);
  await stopBridgeForPort('docker', options.dockerPort, instance);

  logger.step('Sandbox stopped');
}

/** The macOS stop flow — shared with `delete` (which stops first).
 */
export async function stopMacos(): Promise<void> {
  const options = resolveRunOptions('macos');
  requireTart();
  const { instance } = options;

  logger.title(`Stopping macOS sandbox: ${instance}`);
  await stopTartVm(instance);

  logger.step('Host bridges (SSH agent, Docker)');
  await stopBridgeForPort('ssh-agent', options.agentPort, instance);
  await stopBridgeForPort('docker', options.dockerPort, instance);

  const state = (await vmState(instance)) ?? 'stopped';
  logger.step('Sandbox stopped');
  logger.out(`    ${'VM'.padEnd(12)}${logger.bold(instance)} (${state})`);
  logger.out(
    `    ${'Bridges'.padEnd(12)}host listeners on TCP ${options.agentPort} and ` +
      `${options.dockerPort} stopped`,
  );
}

/** The VMware stop flow — shared by the Ubuntu and Windows backends (the
 *  legacy stop scripts; the guest-side services/bridges stop with the VM).
 *
 * @param platform - The VMware platform to stop.
 */
export async function stopVmware(platform: Platform): Promise<void> {
  const options = resolveRunOptions(platform);
  requireVmrun();
  const vmx = workingVmxPath(platform, options.image, options.instance);

  logger.title(`${platform === 'ubuntu-vmware' ? 'Ubuntu' : 'Windows'} VMware sandbox: ${vmx}`);
  await stopVmwareVmx(vmx);

  logger.step('Host bridges (SSH agent, Docker)');
  await stopBridgeForPort('ssh-agent', options.agentPort, options.instance);
  await stopBridgeForPort('docker', options.dockerPort, options.instance);

  const running = await isVmRunning(vmx);
  logger.step('Sandbox stopped');
  logger.out(`    ${'VM'.padEnd(12)}${logger.bold(vmx)} (${running ? 'running' : 'stopped'})`);
  logger.out(
    `    ${'Bridges'.padEnd(12)}host listeners on TCP ${options.agentPort} and ` +
      `${options.dockerPort} stopped`,
  );
}

/** Stops the macOS working VM with the legacy wait-for-stopped flow. */
async function stopTartVm(vm: string): Promise<void> {
  if (!(await vmExists(vm))) {
    logger.warn(`VM '${vm}' does not exist (was it deleted?) — skipping 'tart stop'.`);
    return;
  }
  if ((await vmState(vm)) !== 'running') {
    logger.info(`VM '${vm}' is already stopped.`);
    return;
  }
  logger.cmd(`tart stop ${vm}`);
  const res = await stopVm(vm);
  if (res.code !== 0) {
    logger.warn(`'tart stop ${vm}' failed — the VM may already be stopping.`);
  }
  process.stdout.write(`    Waiting for '${vm}' to stop`);
  if (await waitForVmState(vm, 'stopped')) {
    process.stdout.write(` ${logger.color('green')}stopped${logger.reset()}\n`);
    logger.ok(`VM '${vm}' is stopped.`);
  } else {
    process.stdout.write(` ${logger.color('yellow')}failed${logger.reset()}\n`);
    logger.warn(`'${vm}' is still running — force it with 'tart stop ${vm} --timeout 1'.`);
  }
}

/** Stops the VMware working VM: graceful `soft` first, hard power-off as
 *  a fallback after a minute (both wait for the running-VM list).
 */
async function stopVmwareVmx(vmx: string): Promise<void> {
  if (!existsSync(vmx)) {
    logger.warn(`No working VM (${vmx}) — was the sandbox ever run?`);
    return;
  }
  if (!(await isVmRunning(vmx))) {
    logger.info('VM is already stopped.');
    return;
  }
  logger.cmd(`vmrun -T fusion stop ${vmx} soft`);
  process.stdout.write('    Waiting for a graceful shutdown (up to 1 min)');
  if (await stopVmGraceful(vmx)) {
    process.stdout.write(` ${logger.color('green')}stopped${logger.reset()}\n`);
    logger.ok(`VM is stopped (${vmx}).`);
  } else {
    process.stdout.write(` ${logger.color('yellow')}failed${logger.reset()}\n`);
    logger.warn("The VM is still running — stop it manually with 'vmrun -T fusion stop'.");
  }
}

/** Kills the bridge we manage on the port (pidfile first), otherwise
 *  reports the listener state like the legacy stop script.
 */
async function stopBridgeForPort(role: BridgeRole, port: number, instance: string): Promise<void> {
  const pid = await stopHostBridge(role, port, instance);
  if (pid !== undefined) {
    logger.ok(`Stopped the host bridge on TCP ${port} (pid ${pid}).`);
    return;
  }
  const pids = await listenerPids(port);
  if (pids.length === 0) {
    logger.info(`No listener on TCP port ${port} — nothing to stop.`);
    return;
  }
  for (const listener of pids) {
    const command = await processCommand(listener);
    if (!command.includes('bridge.js')) {
      logger.warn(
        `Listener on TCP ${port} (pid ${listener}) is not an agent-dev-env ` +
          'bridge — leaving it alone.',
      );
      continue;
    }
    await run('kill', [String(listener)]);
    logger.ok(`Stopped the host bridge on TCP ${port} (pid ${listener}).`);
  }
}

/** @internal — pids listening on the given TCP port (lsof -ti). */
async function listenerPids(port: number): Promise<number[]> {
  const res = await run('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN']);
  if (res.code !== 0) {
    return [];
  }
  return res.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** @internal — the command line of a pid (`ps -p pid -o command=`). */
async function processCommand(pid: number): Promise<string> {
  const res = await run('ps', ['-p', String(pid), '-o', 'command=']);
  return res.code === 0 ? res.stdout.trim() : '';
}

/** tart prereq (same message as the runner). */
function requireTart(): void {
  if (!tartAvailable()) {
    logger.die("tart is not installed — run 'brew install cirruslabs/cli/tart' first.");
  }
}

/** vmrun prereq (same message as the runner). */
function requireVmrun(): void {
  if (!findVmrun()) {
    logger.die(
      'vmrun not found — install VMware Fusion (free for personal use) or set FUSION_APP_PATH.',
    );
  }
}
