// vmrun.ts — vmrun resolution + the VMware helpers the runners, stop and
// delete flows share. Phase 1 landed the binary resolution + `list`;
// Phase 4 adds the hardware-upgrade/guest-IP/tools-state/shared-folder
// helpers for the VMware backends (the port of scripts/lib/vmware.sh).
//
// The pure parsers stay unit-testable (vmrun writes plain text); the IO
// wrappers stay thin. Hangs are bounded with withTimeout — vmrun's
// getGuestIPAddress/checkToolsState can hang past their own timeouts, and
// upgradevm never exits by design (it blocks after doing the work).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isExecutable, run, sleep, which, withTimeout } from './exec.js';

const DEFAULT_FUSION_APP = '/Applications/VMware Fusion.app';

/** Resolves the vmrun binary: PATH first, then the Fusion app bundle —
 *  the same order as scripts/lib/vmware.sh.
 *
 * @param env - Environment (FUSION_APP_PATH override).
 * @returns The vmrun path, or undefined when not found.
 */
export function findVmrun(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const onPath = which('vmrun', env);
  if (onPath) {
    return onPath;
  }
  const fusionApp = env.FUSION_APP_PATH ?? DEFAULT_FUSION_APP;
  const candidate = join(fusionApp, 'Contents', 'Public', 'vmrun');
  return isExecutable(candidate) ? candidate : undefined;
}

export interface VmrunOptions {
  vmrun?: string;
  env?: Record<string, string | undefined>;
}

/** `vmrun -T fusion <args>`, resolving the binary when not given. */
function vmrunCommand(
  args: string[],
  options: VmrunOptions = {},
): {
  cmd: string;
  argv: string[];
} {
  const vmrun = options.vmrun ?? findVmrun(options.env);
  if (!vmrun) {
    throw new Error(
      'vmrun not found — install VMware Fusion (free for personal use) or set FUSION_APP_PATH.',
    );
  }
  return { cmd: vmrun, argv: ['-T', 'fusion', ...args] };
}

/** Lists the paths of the running VMs, from `vmrun -T fusion list`.
 *
 * @param options - vmrun path / env overrides.
 * @returns The running VMs' vmx paths.
 * @throws Error when vmrun is missing or the list fails.
 */
export async function listRunningVms(options: VmrunOptions = {}): Promise<string[]> {
  const { cmd, argv } = vmrunCommand(['list'], options);
  const res = await run(cmd, argv);
  if (res.code !== 0) {
    throw new Error(`vmrun list failed:\n${res.stderr.trim()}`);
  }
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^Total running VMs:/i.test(line));
}

/** Normalizes a vmx path for comparison (vmrun list output vs our
 *  derived path — whitespace/case aside, the path itself must match).
 *
 * @param path - The path to normalize.
 * @returns The path with duplicate slashes collapsed.
 */
function normalizeVmxPath(path: string): string {
  return path.replace(/\/+/g, '/');
}

/** Whether the working VM is in Fusion's running-VM list.
 *
 * @param vmx - The vmx path to look up.
 * @param options - vmrun path / env overrides.
 * @returns True when the VM is running.
 */
export async function isVmRunning(vmx: string, options: VmrunOptions = {}): Promise<boolean> {
  try {
    const running = await listRunningVms(options);
    return running.some((path) => normalizeVmxPath(path) === normalizeVmxPath(vmx));
  } catch {
    return false;
  }
}

/** Waits until the VM disappears from the running list.
 *
 * @param vmx - The working VM vmx.
 * @param tries - Poll attempts (30 = up to 1 min at 2 s apart).
 * @param delayMs - Delay between attempts.
 * @returns True when the VM stopped within the window.
 */
export async function waitForVmNotRunning(
  vmx: string,
  tries = 30,
  delayMs = 2000,
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (!(await isVmRunning(vmx))) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

/** @internal — the strict last-line extraction of a vmrun answer
 *  (handles a trailing newline like the shell's `tail -n1`).
 *
 * @param output - The raw vmrun output.
 * @returns The last non-empty trimmed line, or undefined.
 */
function lastOutputLine(output: string): string | undefined {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

/** @internal — the `virtualhw.version` line from a vmx text. */
export function parseVmwareHwVersion(content: string): string | undefined {
  const match = /^[ \t]*virtualhw\.version[ \t]*=[ \t]*"([0-9]+)"/m.exec(content);
  return match?.[1];
}

/** The working VM's hardware version (sed port; reads the vmx).
 *
 * @param vmx - The vmx path.
 * @returns The version string, or undefined when absent.
 */
export function vmwareHwVersion(vmx: string): string | undefined {
  try {
    return parseVmwareHwVersion(readFileSync(vmx, 'utf8'));
  } catch {
    return undefined;
  }
}

/** @internal — rewrites the displayname key of a vmx (case-insensitive:
 *  replaces every `displayname =` / `displayName =` line with the new
 *  name, appends one at the end when the vmx has none — the awk port).
 *  A second, case-variant key would make Fusion refuse the VM.
 *
 * @param content - The vmx text.
 * @param name - The VM's display name.
 * @returns The rewritten text.
 */
export function rewriteVmxDisplayName(content: string, name: string): string {
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (hasTrailingNewline) {
    lines.pop(); // the split artifact of the trailing newline
  }
  let seen = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^[ \t]*displayname[ \t]*=/i.test(line)) {
      out.push(`displayname = "${name}"`);
      seen = true;
      continue;
    }
    out.push(line);
  }
  if (!seen) {
    out.push(`displayname = "${name}"`);
  }
  return out.join('\n') + (hasTrailingNewline ? '\n' : '');
}

/** Sets the vmx displayName (the name Fusion's library shows) —
 *  `vmrun clone` inherits the base's name, so the working clone would
 *  otherwise be indistinguishable from the pristine image.
 *
 * @param vmx - The vmx path.
 * @param name - The display name.
 * @returns True when the file was rewritten.
 */
export function setVmDisplayName(vmx: string, name: string): boolean {
  try {
    writeFileSync(vmx, rewriteVmxDisplayName(readFileSync(vmx, 'utf8'), name));
    return true;
  } catch {
    return false;
  }
}

function vmrunRaw(args: string[], options: VmrunOptions = {}) {
  const { cmd, argv } = vmrunCommand(args, options);
  return run(cmd, argv);
}

/** Copies the base VM into the working VM (`vmrun clone <src> <dst>
 *  full`).
 *
 * @param sourceVmx - The pristine (base) vmx.
 * @param destinationVmx - The working vmx.
 * @param options - vmrun path / env overrides.
 * @returns The raw result.
 */
export function cloneVm(
  sourceVmx: string,
  destinationVmx: string,
  options: VmrunOptions = {},
): ReturnType<typeof run> {
  return vmrunRaw(['clone', sourceVmx, destinationVmx, 'full'], options);
}

/** Starts the VM (`vmrun start <vmx> gui|nogui`).
 *
 * @param vmx - The working vmx.
 * @param mode - gui (Fusion window) or nogui (headless).
 * @param options - vmrun path / env overrides.
 * @returns The raw result.
 */
export function startVm(
  vmx: string,
  mode: 'gui' | 'nogui' = 'gui',
  options: VmrunOptions = {},
): ReturnType<typeof run> {
  return vmrunRaw(['start', vmx, mode], options);
}

/** Stops the VM (`vmrun stop <vmx> [soft]`; soft = graceful via VMware
 *  Tools).
 *
 * @param vmx - The working vmx.
 * @param mode - soft (default) or a hard power-off.
 * @param options - vmrun path / env overrides.
 * @returns The raw result.
 */
export function stopVm(
  vmx: string,
  mode: 'soft' | 'hard' = 'soft',
  options: VmrunOptions = {},
): ReturnType<typeof run> {
  const args = mode === 'soft' ? ['stop', vmx, 'soft'] : ['stop', vmx];
  return vmrunRaw(args, options);
}

/** The stop flow of the legacy stop script: graceful `soft` stop, hard
 *  power-off after a minute, both with the wait-for-stopped poll.
 *
 * @param vmx - The working vmx.
 * @param options - vmrun path / env overrides.
 * @returns True when the VM was (or already is) stopped.
 */
export async function stopVmGraceful(vmx: string, options: VmrunOptions = {}): Promise<boolean> {
  if (!(await isVmRunning(vmx, options))) {
    return true;
  }
  await stopVm(vmx, 'soft', options);
  if (await waitForVmNotRunning(vmx, 30, 2000)) {
    return true;
  }
  await stopVm(vmx, 'hard', options);
  return waitForVmNotRunning(vmx, 30, 2000);
}

/** @internal — strict dotted-quad parse of `getGuestIPAddress` output
 *  (the error text "The VMware Tools are not running…" must never become
 *  the guest IP).
 *
 * @param output - The raw vmrun output (last line is the answer).
 * @returns The IP, or undefined when not a valid dotted quad.
 */
export function parseGuestIpAddress(output: string): string | undefined {
  const ip = lastOutputLine(output) ?? '';
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip) && ip !== '0.0.0.0'
    ? ip
    : undefined;
}

/** The guest IP as reported by open-vm-tools, bounded (vmrun has no
 *  timeout of its own — the perl alarm wrapper port).
 *
 * @param vmx - The working vmx.
 * @param options - vmrun path / env overrides.
 * @returns The dotted-quad IP, or undefined before the tools answer.
 */
export async function getGuestIpAddress(
  vmx: string,
  options: VmrunOptions = {},
): Promise<string | undefined> {
  const { cmd, argv } = vmrunCommand(['getGuestIPAddress', vmx], options);
  try {
    const res = await withTimeout(run(cmd, argv), 30_000, 'vmrun getGuestIPAddress timed out');
    return res.code === 0 ? parseGuestIpAddress(res.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** @internal — the last non-empty vmrun line (checkToolsState's answer).
 *
 * @param output - The raw vmrun output.
 * @returns The trimmed last line, or undefined when empty.
 */
export function parseToolsState(output: string): string | undefined {
  return lastOutputLine(output);
}

/** The VMware Tools state vmrun reports (`running`/`notrunning`),
 *  bounded like the IP fetch.
 *
 * @param vmx - The working vmx.
 * @param options - vmrun path / env overrides.
 * @returns The state string, or undefined on failure/timeout.
 */
export async function checkToolsState(
  vmx: string,
  options: VmrunOptions = {},
): Promise<string | undefined> {
  const { cmd, argv } = vmrunCommand(['checkToolsState', vmx], options);
  try {
    const res = await withTimeout(run(cmd, argv), 30_000, 'vmrun checkToolsState timed out');
    return res.code === 0 ? parseToolsState(res.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** The "Already exists" case from addSharedFolder (a share registered by
 *  a previous run is fine).
 *
 * @param err - The command's combined output.
 * @returns True when the share is already registered.
 */
export function sharedFolderAlreadyExists(err: string): boolean {
  return /already exists/i.test(err);
}

/** Registers a shared folder with vmrun (`addSharedFolder <vmx> <name>
 *  <path>`); the caller retries — the tools state can flip back right
 *  after checkToolsState reports running.
 *
 * @param vmx - The working vmx.
 * @param name - Share name inside the guest.
 * @param path - Host directory to share.
 * @param options - vmrun path / env overrides.
 * @returns The raw result.
 */
export function addSharedFolder(
  vmx: string,
  name: string,
  path: string,
  options: VmrunOptions = {},
): ReturnType<typeof run> {
  return vmrunRaw(['addSharedFolder', vmx, name, path], options);
}

/** Enables the registered shares for the running VM (best effort —
 *  `enableSharedFolders <vmx> runtime`), like the shell's `|| true`.
 *
 * @param vmx - The working vmx.
 * @param options - vmrun path / env overrides.
 */
export async function enableSharedFolders(vmx: string, options: VmrunOptions = {}): Promise<void> {
  const { cmd, argv } = vmrunCommand(['enableSharedFolders', vmx, 'runtime'], options);
  await run(cmd, argv);
}

/** Upgrades the VM to the hardware version the installed Fusion supports
 *  (vmrun upgradevm — which never exits, hence the 180 s cap; the work
 *  finishes before it blocks). The caller records .hw-version so it runs
 *  once per VM version.
 *
 * @param vmx - The working vmx.
 * @param options - vmrun path / env overrides.
 * @returns The resulting hardware version (or undefined when unreadable).
 */
export async function upgradeVmHardware(
  vmx: string,
  options: VmrunOptions = {},
): Promise<string | undefined> {
  const before = vmwareHwVersion(vmx);
  const { cmd, argv } = vmrunCommand(['upgradevm', vmx], options);
  try {
    // timeoutMs both rejects after 180 s AND SIGKILLs the child: a
    // bare withTimeout(run(...)) only raced the promise, so the
    // never-exiting vmrun child stayed alive holding the CLI's stdio
    // pipes — node's event loop never drained and the CLI hung after
    // printing the successful build summary.
    await withTimeout(run(cmd, argv, { timeoutMs: 180_000 }), 180_000, 'vmrun upgradevm timed out');
  } catch {
    // upgradevm never exits — the timeout is expected; the vmx is
    // written before it blocks.
  }
  return vmwareHwVersion(vmx) ?? before;
}
