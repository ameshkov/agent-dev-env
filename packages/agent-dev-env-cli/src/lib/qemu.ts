// lib/qemu.ts — the QEMU/Windows backend's host-side helpers (Phase 6):
// the working-VM state paths (COW overlay + persistent TPM + EFI NVRAM
// under <data>/windows-qemu/<image>/working/), the backing-image identity
// marker (a rebuild replaces the qcow2 at the same path — path alone
// would silently stack the old overlay on a different base), the exact
// `launch_qemu` args builder (same wiring the image was built with:
// qemu-with-tpm.sh, minus the install media) and the swtpm/qemu process
// management (pidfiles, stale-process kills, the pgrep fallback). Port of
// run-windows-qemu-sandbox.sh §step 2/3/4 helpers + the stop script.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { commandExists, isAlive, readPidFile, run, sleep, spawnDetached } from './exec.js';
import { logger } from './logger.js';
import { imageRootDir, paths } from './paths.js';

/** The platform id the qemu state paths are bound to. */
const PLATFORM = 'windows-qemu' as const;

/** The address the guest reaches the host at (QEMU user-mode networking
 *  NAT gateway — the host bridges bind 127.0.0.1 instead).
 */
export const QEMU_HOST_ALIAS = '10.0.2.2';

/** Homebrew's qemu UEFI firmware (the efi_code in launch_qemu). */
export const QEMU_EFI_CODE = '/opt/homebrew/share/qemu/edk2-aarch64-code.fd';

/** Homebrew's qemu EFI vars template (seeded when the build output ships
 *  no efivars.fd). */
export const QEMU_EFI_VARS_TEMPLATE = '/opt/homebrew/share/qemu/edk2-arm-vars.fd';

// --- state paths -------------------------------------------------------------

/** <data>/windows-qemu/<image> — the per-image state root (shared across
 *  instances: pristine cache + working/<instance> state dirs).
 * @param image - The image name.
 * @returns The state root.
 */
export function qemuStateDir(image: string): string {
  return imageRootDir(PLATFORM, image);
}

/** <data>/windows-qemu/<image>/image/<image>.qcow2 — the assembled
 *  pristine disk (the COW overlay's backing file).
 * @param image - The image name.
 * @returns The pristine qcow2 path.
 */
export function qemuImagePath(image: string): string {
  return join(qemuStateDir(image), 'image', `${image}.qcow2`);
}

/** <data>/windows-qemu/<image>/image/parts — the transient pull staging
 *  (part-NNNN + parts.json; deleted once the qcow2 is assembled).
 * @param image - The image name.
 * @returns The parts staging directory.
 */
export function qemuPartsDir(image: string): string {
  return join(qemuStateDir(image), 'image', 'parts');
}

/** The marker recording the chunk-set identity the pristine qcow2 was
 *  assembled from (a partial assembly after a crash must never pass as
 *  the pristine disk).
 * @param image - The image name.
 * @returns The verified marker path.
 */
export function qemuImageVerified(image: string): string {
  return `${qemuImagePath(image)}.verified`;
}

/** Whether the pristine qcow2 was fully assembled from a chunk set.
 * @param image - The image name.
 * @returns True when the qcow2 and its verified marker exist.
 */
export function qemuImageReady(image: string): boolean {
  return existsSync(qemuImagePath(image)) && existsSync(qemuImageVerified(image));
}

/** <data>/windows-qemu/<image>/working/<instance> — one instance's working
 *  VM state dir (overlay, efivars.fd, tpm/, pidfiles, sockets).
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The instance's working dir.
 */
export function qemuWorkingDir(image: string, instance: string): string {
  return join(qemuStateDir(image), 'working', instance);
}

/** <data>/windows-qemu/<image>/working/<instance>/<image>.qcow2 — the COW
 *  overlay the running VM writes to.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The overlay path.
 */
export function qemuOverlayPath(image: string, instance: string): string {
  return join(qemuWorkingDir(image, instance), `${image}.qcow2`);
}

/** The backing-image identity marker (path|size|mtime of the pristine
 *  disk the overlay was created from).
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The marker path.
 */
export function qemuBackingMarker(image: string, instance: string): string {
  return join(qemuWorkingDir(image, instance), 'backing-image.txt');
}

/** The working VM's persistent EFI NVRAM store.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The efivars.fd path.
 */
export function qemuEfivarsPath(image: string, instance: string): string {
  return join(qemuWorkingDir(image, instance), 'efivars.fd');
}

/** The working VM's TPM state dir (Windows 11 needs TPM 2.0 and its
 *  credentials must survive reboots).
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The tpm dir.
 */
export function qemuTpmDir(image: string, instance: string): string {
  return join(qemuWorkingDir(image, instance), 'tpm');
}

/** The qemu pidfile the runner writes.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The qemu.pid path.
 */
export function qemuPidFile(image: string, instance: string): string {
  return join(qemuWorkingDir(image, instance), 'qemu.pid');
}

/** The swtpm pidfile (swtpm --pid writes it after daemonizing).
 *
 * @internal — test-only export; production callers go through
 * startSwtpm/stopSwtpm, which read this pidfile themselves.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The swtpm.pid path.
 */
export function swtpmPidFile(image: string, instance: string): string {
  return join(qemuWorkingDir(image, instance), 'swtpm.pid');
}

/** The swtpm control socket qemu connects its chardev to.
 *
 *  The socket lives under the system temp dir, NOT next to the working
 *  state: swtpm limits the Unix control socket path to ~107 chars
 *  (sockaddr_un sun_path), and the per-instance state path
 *  (<data>/windows-qemu/<image>/working/<instance>/swtpm.sock) exceeds
 *  it on macOS (~129 chars — swtpm exits with "Path for UnioIO socket is
 *  too long"). The socket is ephemeral (the TPM STATE persists in the
 *  working dir); the key hashes image+instance so instances never share
 *  a socket, and the uid is prefixed so host users cannot collide in the
 *  shared /tmp.
 *
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The swtpm.sock path (short, under the system temp dir).
 */
export function swtpmSockPath(image: string, instance: string): string {
  const key = createHash('sha1').update(`${image}/${instance}`).digest('hex').slice(0, 12);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  return join(tmpdir(), `ade-sw-tpm-${uid}-${key}.sock`);
}

/** The swtpm log (level=20), next to the socket.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The swtpm.log path.
 */
function swtpmLogPath(image: string, instance: string): string {
  return join(qemuWorkingDir(image, instance), 'swtpm.log');
}

/** The qemu log (the running VM's stdout/stderr).
 * @param instance - The instance name.
 * @returns The log path under the CLI's log dir.
 */
export function qemuLogPath(instance: string): string {
  return join(paths.logs, `qemu-windows-11-${instance}.log`);
}

/** The pristine-disk identity (path|size|mtime; the same scheme as
 *  vmware-image's archive marker — a rebuild packs the new image at the
 *  SAME path, so the path alone misses it).
 *
 * @param path - The disk path.
 * @param size - File size in bytes.
 * @param mtimeMs - File mtime (ms since epoch).
 * @returns The identity string.
 */
export function backingIdentity(path: string, size: number, mtimeMs: number): string {
  return `${path}|${size}|${Math.floor(mtimeMs / 1000)}`;
}

// --- args builder ------------------------------------------------------------

/** The inputs for one qemu invocation (the launch_qemu port). */
export interface QemuArgsInput {
  /** UEFI firmware code (edk2-aarch64-code.fd). */
  efiCode: string;
  /** The working VM's EFI vars store. */
  efivars: string;
  /** The COW overlay disk. */
  overlay: string;
  /** The swtpm control socket. */
  tpmSock: string;
  /** Host port forwarded to guest SSH 22. */
  sshPort: number;
  /** Host port forwarded to guest RDP 3389. */
  rdpPort: number;
  /** Host port forwarded to guest OpenChamber. */
  openchamberPort: number;
  /** Host port forwarded to guest WinRM 5985. */
  winrmPort: number;
  cpuCount: number;
  memoryMb: number;
  /** Headless (no display window). */
  headless: boolean;
}

/** Builds the exact `launch_qemu` arg list (same wiring the image was
 *  built with, minus the install media): virt machine, HVF, AAVMF UEFI,
 *  swtpm TPM 2.0 (ppi=off avoids a QEMU 11.1 HVF regression), xhci +
 *  keyboard + tablet, user-mode networking with the port forwards and
 *  virtio-gpu-pci (the image's driver store resolves viogpudo, so
 *  resizing the window changes the guest resolution).
 *
 * @param input - The resolved wiring.
 * @returns The qemu-system-aarch64 arguments.
 */
export function buildQemuArgs(input: QemuArgsInput): string[] {
  const hostfwd = [
    `hostfwd=tcp:127.0.0.1:${input.sshPort}-:22`,
    `hostfwd=tcp:127.0.0.1:${input.rdpPort}-:3389`,
    `hostfwd=tcp:127.0.0.1:${input.openchamberPort}-:${input.openchamberPort}`,
    `hostfwd=tcp:127.0.0.1:${input.winrmPort}-:5985`,
  ].join(',');
  return [
    '-machine',
    'virt,gic-version=max',
    '-accel',
    'hvf',
    '-cpu',
    'host',
    '-smp',
    String(input.cpuCount),
    '-m',
    String(input.memoryMb),
    '-drive',
    `if=pflash,format=raw,readonly=on,file=${input.efiCode}`,
    '-drive',
    `if=pflash,format=raw,file=${input.efivars}`,
    '-drive',
    `file=${input.overlay},if=virtio,format=qcow2`,
    '-device',
    'virtio-net-pci,netdev=net0',
    '-netdev',
    `user,id=net0,${hostfwd}`,
    '-chardev',
    `socket,id=chrtpm,path=${input.tpmSock}`,
    '-tpmdev',
    'emulator,id=tpm0,chardev=chrtpm',
    '-device',
    'tpm-tis-device,tpmdev=tpm0,ppi=off',
    '-device',
    'virtio-gpu-pci',
    '-device',
    'qemu-xhci,id=usb',
    '-device',
    'usb-kbd,bus=usb.0',
    '-device',
    'usb-tablet,bus=usb.0',
    ...(input.headless ? ['-display', 'none'] : ['-display', 'cocoa,zoom-to-fit=on']),
  ];
}

// --- prereq ------------------------------------------------------------------

/** The qemu/swtpm prereq (same message as doctor).
 */
export function requireQemu(): void {
  if (!commandExists('qemu-system-aarch64')) {
    logger.die("qemu-system-aarch64 is not installed — run 'brew install qemu' first.");
  }
  if (!commandExists('qemu-img')) {
    logger.die("qemu-img is not installed — run 'brew install qemu' first.");
  }
  if (!commandExists('swtpm')) {
    logger.die("swtpm is not installed — run 'brew install swtpm' first.");
  }
}

// --- process helpers ---------------------------------------------------------

/** @internal — SIGTERM + poll up to 30 s (the stop script's kill_wait).
 * @param label - The process label (qemu / swtpm).
 * @param pid - The pid to stop.
 * @returns True when the process is gone.
 */
async function killWait(label: string, pid: number): Promise<boolean> {
  if (!isAlive(pid)) {
    logger.info(`${label} is already stopped (pid ${pid} is not running).`);
    return true;
  }
  logger.cmd(`kill ${pid}`);
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
  process.stdout.write(`    Waiting for ${label} to stop`);
  for (let n = 0; n < 30; n += 1) {
    if (!isAlive(pid)) {
      process.stdout.write(` ${logger.color('green')}stopped${logger.reset()}\n`);
      return true;
    }
    await sleep(1000);
  }
  process.stdout.write(` ${logger.color('yellow')}failed${logger.reset()}\n`);
  logger.warn(
    `${label} (pid ${pid}) did not stop after 30 s — kill it manually with: kill -9 ${pid}`,
  );
  return false;
}

/** Whether a runner-launched qemu is alive (pidfile first, then the
 *  overlay-path pgrep fallback — the path is unique to this sandbox).
 *
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns True when qemu is running.
 */
export function isQemuAlive(image: string, instance: string): boolean {
  const pid = readPidFile(qemuPidFile(image, instance));
  if (pid !== undefined) {
    return isAlive(pid);
  }
  return false;
}

/** @internal — runner-launched qemu pids by overlay path command line
 *  (a pidfile-less qemu from a crashed run).
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The pids, in pgrep order.
 */
async function findQemuPids(image: string, instance: string): Promise<number[]> {
  const res = await run('pgrep', ['-f', `qemu-system-aarch64.*${qemuWorkingDir(image, instance)}`]);
  if (res.code !== 0) {
    return [];
  }
  return res.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Stops the sandbox qemu (pidfile first, pgrep fallback) — the stop
 *  script's stop_qemu. Idempotent.
 *
 * @param image - The image name.
 * @param instance - The instance name.
 */
export async function stopQemu(image: string, instance: string): Promise<void> {
  const pidfile = qemuPidFile(image, instance);
  const pid = readPidFile(pidfile);
  if (pid !== undefined) {
    if (isAlive(pid)) {
      await killWait('qemu', pid);
      rmSync(pidfile, { force: true });
      return;
    }
    logger.info(`qemu (pid ${pid}) is not running — removing the stale pidfile.`);
    rmSync(pidfile, { force: true });
  }
  const pids = await findQemuPids(image, instance);
  if (pids.length === 0) {
    logger.info('qemu is not running — nothing to stop.');
    return;
  }
  logger.warn(
    `A sandbox qemu is running (pid(s): ${pids.join(', ')}) with no pidfile — stopping it.`,
  );
  for (const running of pids) {
    await killWait('qemu', running);
  }
}

/** Stops swtpm (it otherwise holds the TPM state lock and blocks the next
 *  run) and removes the stale pidfile + socket. Idempotent.
 *
 * @param image - The image name.
 * @param instance - The instance name.
 */
export async function stopSwtpm(image: string, instance: string): Promise<void> {
  const pidfile = swtpmPidFile(image, instance);
  const pid = readPidFile(pidfile);
  if (pid !== undefined) {
    if (isAlive(pid)) {
      await killWait('swtpm', pid);
    } else {
      logger.info(`swtpm (pid ${pid}) is not running — removing the stale pidfile.`);
    }
  } else {
    logger.info(`No swtpm pidfile (${pidfile}) — nothing to stop.`);
  }
  rmSync(pidfile, { force: true });
  rmSync(swtpmSockPath(image, instance), { force: true });
}

/** Starts swtpm (TPM 2.0; the state must persist for the credentials
 *  inside the guest to keep working). A stale swtpm from a previous run
 *  holds a lock on the TPM state dir — kill it first like the shell.
 *
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The daemonized swtpm pid.
 */
export async function startSwtpm(image: string, instance: string): Promise<number> {
  const sock = swtpmSockPath(image, instance);
  const pidfile = swtpmPidFile(image, instance);
  const tpm = qemuTpmDir(image, instance);
  const old = readPidFile(pidfile);
  if (old !== undefined && isAlive(old)) {
    logger.warn(`stale swtpm (pid ${old}) still running — stopping it.`);
    try {
      process.kill(old, 'SIGTERM');
    } catch {
      // already gone
    }
    await sleep(1000);
  }
  rmSync(sock, { force: true });
  rmSync(pidfile, { force: true });
  mkdirSync(tpm, { recursive: true });

  logger.cmd(`swtpm socket --tpm2 --tpmstate dir=${tpm} --ctrl type=unixio,path=${sock}`);
  const res = await run('swtpm', [
    'socket',
    '--tpmstate',
    `dir=${tpm}`,
    '--ctrl',
    `type=unixio,path=${sock}`,
    '--log',
    `file=${swtpmLogPath(image, instance)},level=20`,
    '--pid',
    `file=${pidfile}`,
    '--tpm2',
    '--daemon',
  ]);
  if (res.code !== 0) {
    logger.die(`swtpm failed to start:\n${res.stderr.trim()}`);
  }
  for (let n = 0; n < 10 && !existsSync(sock); n += 1) {
    await sleep(1000);
  }
  if (!existsSync(sock)) {
    logger.die(`swtpm socket ${sock} did not appear (see ${swtpmLogPath(image, instance)}).`);
  }
  const pid = readPidFile(pidfile) ?? -1;
  logger.ok(`swtpm is up (pid ${pid}).`);
  return pid;
}

/** Launches qemu detached (the VM outlives the CLI by design; the log
 *  gets stdout+stderr) and records the pidfile for stop/status.
 *
 * @param image - The image name.
 * @param instance - The instance name.
 * @param args - The qemu-system-aarch64 arguments (buildQemuArgs).
 * @returns The qemu pid.
 */
export async function launchQemu(image: string, instance: string, args: string[]): Promise<number> {
  const logDir = dirname(qemuLogPath(instance));
  mkdirSync(logDir, { recursive: true });
  logger.cmd(`qemu-system-aarch64 ${args.join(' ')}`);
  logger.info(`Running the VM in the background (output: ${qemuLogPath(instance)}).`);
  const pid = spawnDetached('qemu-system-aarch64', args, { logFile: qemuLogPath(instance) });
  writeFileSync(qemuPidFile(image, instance), `${pid}\n`);
  return pid;
}
