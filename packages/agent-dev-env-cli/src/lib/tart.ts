// tart.ts — tart invocation wrappers, the unified replacement for the
// scattered `tart list`/`ip`/`clone`/`set`/`run`/`stop`/`exec`/`pull`
// calls in the macOS runner/stop/delete/sync shell scripts (and the
// parsing in commands/status.ts).
//
// The arg builders and parsers are pure and unit-tested; the wrappers
// themselves stay thin (run + error translation). Throwing happens at
// the caller boundary like the shell's `|| die` — the wrappers report
// raw results, the runners turn them into the legacy messages.

import { commandExists, run, sleep, type RunOptions, type RunResult } from './exec.js';

/** True when tart is on PATH (doctor/run preflight check). */
export function tartAvailable(): boolean {
  return commandExists('tart');
}

/** @internal — Parses `tart list` rows into a name → state map
 *  (exported for the co-located unit tests; callers use listVms()).
 *
 * `tart list` prints one row per VM: `source name disk used … state` —
 * the name is the second column, the state the last one. Header lines
 * (starting with `Source`) and blank lines are skipped.
 *
 * @param output - The raw stdout of `tart list`.
 * @returns Map of VM name → state (e.g. `running`, `stopped`).
 */
export function parseTartList(output: string): Map<string, string> {
  const vms = new Map<string, string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^Source\s/.test(trimmed)) {
      continue;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length >= 2) {
      vms.set(fields[1], fields[fields.length - 1]);
    }
  }
  return vms;
}

/** Runs `tart list` and returns the parsed name → state map.
 *
 * @returns The parsed VM map (empty on failure — callers check).
 */
export async function listVms(): Promise<Map<string, string>> {
  const res = await run('tart', ['list']);
  return res.code === 0 ? parseTartList(res.stdout) : new Map();
}

/** Whether a VM by this name exists in the tart store.
 *
 * @param name - The VM/image name.
 * @returns True when present in `tart list`.
 */
export async function vmExists(name: string): Promise<boolean> {
  return (await listVms()).has(name);
}

/** The VM's state from `tart list` (running/stopped/…).
 *
 * @param name - The VM/image name.
 * @returns The state, or undefined when the VM does not exist.
 */
export async function vmState(name: string): Promise<string | undefined> {
  return (await listVms()).get(name);
}

/** Polls `tart list` until the VM reaches the wanted state.
 *
 * @param name - The VM/image name.
 * @param want - The state to wait for (`running`/`stopped`).
 * @param tries - Poll attempts (60 = up to 2 min at 2 s apart).
 * @param delayMs - Delay between attempts.
 * @returns True when the state was reached.
 */
export async function waitForVmState(
  name: string,
  want: string,
  tries = 60,
  delayMs = 2000,
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if ((await vmState(name)) === want) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

/** The VM's IP from `tart ip` (empty when not reachable yet).
 *
 * @param name - The VM name.
 * @returns The IP, or undefined when tart cannot report one.
 */
export async function vmIp(name: string): Promise<string | undefined> {
  const res = await run('tart', ['ip', name]);
  return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : undefined;
}

/** The host's address on Tart's VM network: always `.1` of the VM's /24.
 *
 * @param ip - The VM's IP (e.g. `192.168.64.34`).
 * @returns The gateway IP, or undefined when the IP is not an IPv4 /24.
 */
export function gatewayFromVmIp(ip: string): string | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return undefined;
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
}

/** Args for `tart set` — the runner's recommended VM settings.
 *
 * @param vm - The VM name.
 * @param cpuCount - CPUs for the freshly cloned VM.
 * @param memoryMb - RAM for the freshly cloned VM, in MB.
 * @returns The argv for `tart set`.
 */
export function tartSetArgs(vm: string, cpuCount: number, memoryMb: number): string[] {
  return [
    'set',
    vm,
    '--cpu',
    String(cpuCount),
    '--memory',
    String(memoryMb),
    '--display',
    '1280x800',
    '--display-refit',
  ];
}

/** Args for `tart run`: the VM's launch flags (legacy order preserved).
 *
 * @param vm - The VM name.
 * @param options - headless vs GUI flags + the optional `--dir` share.
 * @returns The argv for `tart run`.
 */
export function tartRunArgs(vm: string, options: { headless: boolean; dirArg?: string }): string[] {
  const flags = options.headless
    ? ['--no-graphics', '--no-audio']
    : ['--capture-system-keys', '--no-audio'];
  const dir = options.dirArg ? [options.dirArg] : [];
  return ['run', ...flags, ...dir, vm];
}

/** The `--dir=<mount>:<hostDir>` argument for `tart run`.
 *
 * @param mountName - Mount name inside the guest.
 * @param hostDir - Host directory to share.
 * @returns The `--dir` argument value.
 */
export function dirArg(mountName: string, hostDir: string): string {
  return `--dir=${mountName}:${hostDir}`;
}

/** Runs `tart clone` — the working VM is always a clone of the image.
 *
 * @param source - The pristine image VM name.
 * @param dest - The working VM name.
 * @returns The raw result (non-zero on failure, caller decides).
 */
export function cloneVm(source: string, dest: string): Promise<RunResult> {
  return run('tart', ['clone', source, dest]);
}

/** Runs `tart set` with the given argv (tartSetArgs).
 *
 * @param args - Full argv from tartSetArgs.
 * @returns The raw result.
 */
export function setVm(args: string[]): Promise<RunResult> {
  return run('tart', args);
}

/** Runs `tart pull` of a registry ref (GHCR).
 *
 * @param registryRef - e.g. `ghcr.io/<owner>/<image>:latest`.
 * @param options - run() overrides (timeouts etc.).
 * @returns The raw result.
 */
export function pullImage(registryRef: string, options: RunOptions = {}): Promise<RunResult> {
  return run('tart', ['pull', registryRef], options);
}

/** Runs `tart stop` (graceful; tart force-stops after its own timeout).
 *
 * @param vm - The VM name.
 * @returns The raw result.
 */
export function stopVm(vm: string): Promise<RunResult> {
  return run('tart', ['stop', vm]);
}

/** Runs `tart delete` — removes the VM from the store, disk included.
 *
 * @param vm - The VM name.
 * @returns The raw result.
 */
export function deleteVm(vm: string): Promise<RunResult> {
  return run('tart', ['delete', vm]);
}

/** Runs a command inside the guest via `tart exec` (stdin piping with
 *  `-i`).
 *
 * @param vm - The VM name (must be running).
 * @param argv - The command + args to run inside the guest.
 * @param options - `input` (implies `-i`) + run() overrides.
 * @returns The raw result (non-zero on failure, caller decides).
 */
export function execVm(vm: string, argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const interactive = options.input !== undefined ? ['-i'] : [];
  return run('tart', ['exec', ...interactive, vm, ...argv], options);
}

/** The Tart guest agent's launchd unit label in a Cirrus base image guest:
 *  a global agent in the console user's GUI domain — it owns the vdagent
 *  (clipboard) link and the `tart exec` RPC server. The root daemon
 *  (`--run-daemon`) has no clipboard access, so only this unit matters. */
const GUEST_AGENT_LABEL = 'org.cirruslabs.tart-guest-agent';

/** @internal — The restart command for `tart exec` (exported for the
 *  co-located unit tests; production goes through kickstartGuestAgent()).
 *  Kicks the guest agent in the running user's GUI domain — the agent
 *  must run under the GUI user for pasteboard access.
 *
 * @returns The shell command to run inside the guest.
 */
export function guestAgentKickstartCommand(): string {
  return `launchctl kickstart -k gui/$(id -u)/${GUEST_AGENT_LABEL}`;
}

/** Kicks the running guest's Tart guest agent via launchctl so its
 *  vdagent channel is re-established. Clipboard sharing can silently go
 *  stale across VM stop/start cycles while the agent process stays up —
 *  a fresh kick reconnects the vdagent link every time.
 *
 *  The restart kills the RPC server the `tart exec` call itself rides
 *  on, so it usually returns non-zero (or dies at the timeout) even when
 *  the restart worked — callers must wait for the agent to come back
 *  (waitForGuestAgent) before using `tart exec` again.
 *
 * @param vm - The VM name (must be running).
 * @returns The raw result (non-zero on failure, caller decides).
 */
export function kickstartGuestAgent(vm: string): Promise<RunResult> {
  return execVm(vm, ['sh', '-lc', guestAgentKickstartCommand()], { timeoutMs: 10000 });
}

/** Polls the guest agent's `tart exec` RPC until it answers again after a
 *  kickstart — the RPC server exists only in the `--run-agent` instance.
 *
 * @param vm - The VM name (must be running).
 * @param tries - Poll attempts (10 = up to ~10 s).
 * @param delayMs - Delay between attempts.
 * @returns True when `tart exec` answers again.
 */
export async function waitForGuestAgent(vm: string, tries = 10, delayMs = 1000): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const res = await execVm(vm, ['sh', '-lc', 'echo ready']);
    if (res.code === 0 && res.stdout.trim() === 'ready') {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

/** Reports the path of the node binary inside a running guest.
 *
 * Node is installed via nvm and aliased as the default, so it is only on
 * PATH in login shells — resolve once per run and reuse the absolute path
 * for the guest-agent invocations.
 *
 * @param vm - The running VM name.
 * @returns The absolute node path, or undefined when not found.
 */
export async function findGuestNode(vm: string): Promise<string | undefined> {
  const res = await execVm(vm, ['sh', '-lc', 'command -v node']);
  const node = res.code === 0 ? res.stdout.trim() : '';
  return node && node.startsWith('/') ? node : undefined;
}
