// runners/framework.ts — the shared runner flow: the step order and state
// types every platform backend follows, plus the host/arch preflight. The
// four backends (runners/macos.ts, runners/windows-qemu.ts,
// runners/windows.ts, runners/ubuntu.ts) implement the per-platform hooks;
// the step titles and their order stay shell-identical.
//
// Step order: preflight → 1 image+VM → 2 boot → 3 bridges + rules → 4
// settings → 5 OpenChamber → summary → foreground wait.

import type { ChildProcess } from 'node:child_process';
import { logger } from '../lib/logger.js';
import type { SettingsState } from '../settings/macos.js';
import type { RunOptions } from './options.js';

/** The resolved context handed to every backend hook. */
export interface RunContext {
  platform: RunOptions['platform'];
  options: RunOptions;
  /** The working sandbox instance name (SANDBOX_VM / default) — the
   *  Tart VM name on macOS, the per-instance state key elsewhere. */
  instance: string;
  /** Pristine image name (--image / SANDBOX_IMAGE / default). */
  image: string;
  /** Host work dir shared into the guest ('' disables the mount). */
  workDir: string;
  /** Mount name inside the guest. */
  mountName: string;
  /** Guest-side mount path (Tart shares land under this). */
  guestMount: string;
  agentPort: number;
  dockerPort: number;
  openchamberPort: number;
  /** Host port forwarded to guest SSH 22 (windows-qemu). */
  sshPort: number;
  /** Host port forwarded to guest RDP 3389 (windows-qemu). */
  rdpPort: number;
  /** Host port forwarded to guest WinRM 5985 (windows-qemu). */
  winrmPort: number;
  cpuCount: number;
  memoryMb: number;
}

type RulesState =
  'installed' | 'updated' | 'overwritten' | 'kept' | 'failed' | 'uptodate' | 'not-installed';

/** Per-run accumulated state the summary reads (shell legacy globals). */
export interface RunState {
  mode: 'gui' | 'headless';
  /** The working VM was freshly cloned (recommended settings apply). */
  created: boolean;
  /** The VM was already running at step 2 (no `tart run` for it). */
  vmAlreadyRunning: boolean;
  vmIp?: string;
  /** The image file/archive used by the non-Tart backends (run/status
   *  lines). */
  imageArchive?: string;
  /** PID of the `tart run` process (foreground wait / died check). */
  tartPid?: number;
  /** The foreground `tart run` child (finish() waits for it). */
  tartChild?: ChildProcess;
  tartLog: string;
  /** PID of the detached qemu process (windows-qemu boot wait / finish). */
  qemuPid?: number;
  bridges: {
    agent: { bridged: boolean; socket?: string; guestUp: boolean; pid?: number };
    docker: {
      bridged: boolean;
      socket?: string;
      guestUp: boolean;
      engineUp: boolean;
      serverVersion?: string;
      pid?: number;
    };
  };
  rules: RulesState;
  settings: SettingsState;
  openchamberUrl?: string;
  openchamberUp: boolean;
  /** The share was skipped because the guest cannot mount HGFS (Windows
   *  ARM: no HGFS driver in VMware Tools for Windows Arm). */
  sharedFolderSkipped: boolean;
}

/** The per-platform hook set — one implementation per backend. */
export interface SandboxBackend {
  /** Host/arch/tool checks + `--reset` teardown. */
  preflight(context: RunContext, state: RunState): Promise<void>;
  /** Step 1: pull/clone image + working VM. */
  ensureImageAndVm(context: RunContext, state: RunState): Promise<void>;
  /** Step 2: run (or keep) the VM + wait for boot. */
  boot(context: RunContext, state: RunState): Promise<void>;
  /** Step 3: host bridges, guest agent wiring, agent rules. */
  setupBridges(context: RunContext, state: RunState): Promise<void>;
  /** Step 4: user settings copy. */
  setupSettings(context: RunContext, state: RunState): Promise<void>;
  /** Step 5: OpenChamber probe (+ open-in-browser offer). */
  verifyOpenchamber(context: RunContext, state: RunState): Promise<void>;
  /** The summary block. */
  summarize(context: RunContext, state: RunState): Promise<void>;
  /** Foreground-mode wait for the VM + bridge cleanup. */
  finish(context: RunContext, state: RunState): Promise<void>;
}

/** Builds a fresh state object for a run.
 *
 * @param context - The run context (mode + log dir).
 * @returns The initial state.
 */
function createRunState(context: RunContext): RunState {
  return {
    mode: context.options.headless ? 'headless' : 'gui',
    created: false,
    vmAlreadyRunning: false,
    tartLog: '',
    bridges: {
      agent: { bridged: false, guestUp: false },
      docker: { bridged: false, guestUp: false, engineUp: false },
    },
    rules: 'not-installed',
    settings: 'skipped',
    openchamberUp: false,
    sharedFolderSkipped: false,
  };
}

/** The host requirement, shared by every backend (doctor's §1 checks).
 *  Host = macOS Apple Silicon; the runners cannot virtualize ARM64
 *  guests on Intel.
 */
function assertSandboxHost(): void {
  if (process.platform !== 'darwin') {
    logger.die('the sandbox runners run on macOS only (Linux is not supported at runtime).');
  }
  if (process.arch !== 'arm64') {
    logger.die(
      'Apple Silicon required — Tart/QEMU/Fusion cannot virtualize ARM64 guests on Intel.',
    );
  }
}

/** Runs the shared step order for a backend.
 *
 * @param backend - The platform backend.
 * @param context - The resolved run context.
 * @returns The process exit code (0 after a successful run).
 */
export async function runSandbox(backend: SandboxBackend, context: RunContext): Promise<number> {
  assertSandboxHost();
  const state = createRunState(context);

  await backend.preflight(context, state);
  logger.step('Step 1/5: Sandbox image and working VM');
  await backend.ensureImageAndVm(context, state);
  logger.step('Step 2/5: Starting the VM');
  await backend.boot(context, state);
  logger.step('Step 3/5: Host bridges (SSH agent, Docker)');
  await backend.setupBridges(context, state);
  logger.step('Step 4/5: User settings');
  await backend.setupSettings(context, state);
  logger.step('Step 5/5: OpenChamber');
  await backend.verifyOpenchamber(context, state);
  await backend.summarize(context, state);
  await backend.finish(context, state);
  return 0;
}
