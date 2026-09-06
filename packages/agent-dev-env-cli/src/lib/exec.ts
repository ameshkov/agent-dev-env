// exec.ts — process helpers, the unified replacement for the shell
// scripts' repeated spawn/nohup/alarm/lsof glue:
//
//   run()            spawn + wait, captured stdout/stderr (replaces
//                    backticks/$(...) subshells)
//   runChecked()     run, throw on non-zero (replaces `cmd || die`)
//   commandExists()  `command -v`
//   which()          full path of a command on PATH
//   isAlive()        kill -0
//   readPidFile()    pid files the runners/stop scripts share
//   spawnDetached()  nohup-style detached process with a log file
//   killTree()       kill -0 pid && recursive pkill -P
//   withTimeout()    the perl alarm wrapper (upgradevm, ip polls, ...)

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants as fsConstants, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunOptions {
  cwd?: string;
  /** Merged over process.env. */
  env?: Record<string, string | undefined>;
  /** Text written to stdin (default: nothing, stdin is closed). */
  input?: string;
  /** Kill with SIGKILL when the command runs longer. */
  timeoutMs?: number;
  /** Mirror the child's stdout/stderr to the CLI's own while still
   *  capturing them (live progress for long-running commands —
   *  packer build, tart push, oras push). */
  stream?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
}

/** Git environment variables that git exports while running a hook (e.g.
 *  the pre-commit hook receives `GIT_INDEX_FILE` and `GIT_DIR`). They
 *  point at the *parent* repository, so leaving them in the child's
 *  environment makes a child `git` call that selects its repo with `-C`
 *  silently operate on the wrong repository (the fixture repos in
 *  `git.test.ts` / `tag.test.ts` are reported dirty under the hook
 *  environment). Every git call in the CLI passes its repo explicitly,
 *  so the inherited values are always stripped. */
const GIT_REPO_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_GRAFT_FILE',
  'GIT_NAMESPACE',
] as const;

/** The child environment: process.env merged over the caller's overrides,
 *  minus the git repo-scoped hook variables.
 *
 * @param overrides - The caller's env overrides (optional).
 * @returns The env to pass to spawn.
 */
function childEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  for (const key of GIT_REPO_ENV_VARS) {
    delete env[key];
  }
  return env;
}

/** Spawns a command and waits for it to exit, capturing stdout/stderr.
 *  The CLI's own SIGINT/SIGTERM are forwarded to the child so a Ctrl+C
 *  during a long-running command (tart push, oras push, packer build)
 *  stops the child too — without forwarding the child is orphaned and
 *  keeps running after the CLI dies (the deploy/build cancel case).
 *
 * @param cmd - The command to run.
 * @param args - Command-line arguments.
 * @param options - cwd/env/input/timeout overrides.
 * @returns The exit code + captured output (never rejects; spawn failures
 *   yield code -1 with the error in stderr).
 */
export function run(
  cmd: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawnChild(cmd, args, options);
    const output = { stdout: '', stderr: '' };
    attachStdio(child, output, options.stream === true);
    writeInput(child, options.input);
    const removeForwarders = attachSignalForwarders(child);

    const timer =
      options.timeoutMs !== undefined ? armTimeout(child, options.timeoutMs) : undefined;
    let settled = false;

    const finish = (result: RunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    child.on('error', (err) => {
      removeForwarders();
      finish({ code: -1, stdout: output.stdout, stderr: err.message, signal: null });
    });
    child.on('close', (code, signal) => {
      removeForwarders();
      finish({
        code: code ?? -1,
        stdout: output.stdout,
        stderr: output.stderr,
        signal,
      });
    });
  });
}

/** Forwards the parent's SIGINT/SIGTERM to the child (a Ctrl+C must stop
 *  the spawned command, never orphan it) and returns the detach function.
 *
 * @param child - The spawned child.
 * @returns The detach function (removes the signal listeners).
 */
function attachSignalForwarders(child: ChildProcessWithoutNullStreams): () => void {
  const forward = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}

function spawnChild(
  cmd: string,
  args: string[],
  options: RunOptions,
): ChildProcessWithoutNullStreams {
  return spawn(cmd, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function attachStdio(
  child: ChildProcessWithoutNullStreams,
  output: { stdout: string; stderr: string },
  stream: boolean,
): void {
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    output.stdout += d;
    if (stream) {
      process.stdout.write(d);
    }
  });
  child.stderr.on('data', (d: string) => {
    output.stderr += d;
    if (stream) {
      process.stderr.write(d);
    }
  });
}

function writeInput(child: ChildProcessWithoutNullStreams, input: string | undefined): void {
  child.stdin.on('error', () => {
    // EPIPE when the child exits before reading stdin — not fatal.
  });
  if (input !== undefined) {
    child.stdin.write(input);
  }
  child.stdin.end();
}

function armTimeout(child: ChildProcessWithoutNullStreams, ms: number): NodeJS.Timeout {
  return setTimeout(() => {
    child.kill('SIGKILL');
  }, ms);
}

/** run() with a strict non-zero contract; throws with the command's
 *  stderr on failure (the `cmd || die` replacement).
 * @param cmd - The command to run.
 * @param args - Command-line arguments.
 * @param options - cwd/env/input/timeout overrides.
 * @returns The result on success.
 * @throws Error with the stderr detail on a non-zero exit.
 */
export async function runChecked(
  cmd: string,
  args: string[] = [],
  options: RunOptions = {},
): Promise<RunResult> {
  const res = await run(cmd, args, options);
  if (res.code !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim()).trim();
    throw new Error(
      `command failed (${res.code}): ${cmd}${args.length ? ` ${args.join(' ')}` : ''}` +
        (detail ? `\n${detail}` : ''),
    );
  }
  return res;
}

/** True when the file exists and is executable (access X_OK). */
export function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `command -v`-style lookup.
 *
 * @param command - The command name (or a path with `/`).
 * @param env - Environment to resolve PATH from (defaults to process.env).
 * @returns The full path, or undefined when not found.
 */
export function which(
  command: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (command.includes('/')) {
    return isExecutable(command) ? command : undefined;
  }
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Whether the command resolves on PATH.
 *
 * @param command - The command name.
 * @param env - Environment to resolve PATH from (defaults to process.env).
 * @returns True when found executable.
 */
export function commandExists(
  command: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return which(command, env) !== undefined;
}

/** Delays the promise (the shell's `sleep`).
 *
 * @param ms - Milliseconds to wait.
 * @returns A promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** kill -0: whether the process is alive (EPERM counts as alive).
 *
 * @param pid - The process id.
 * @returns True when a process with this pid exists.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads a pid file.
 *
 * @param path - The pid file path.
 * @returns The pid, or undefined when missing/invalid.
 */
export function readPidFile(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The runners' detached-process options. */
export interface SpawnDetachedOptions {
  /** Append stdio to this file (like `nohup … >> log 2>&1`). */
  logFile?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

/** nohup-equivalent: a detached process that survives the
 *  CLI exiting. Returns the pid for the runner's pid file.
 * @param cmd - The command to run detached.
 * @param args - Command-line arguments.
 * @param options - Log file / cwd / env overrides.
 * @returns The spawned pid.
 */
export function spawnDetached(
  cmd: string,
  args: string[],
  options: SpawnDetachedOptions = {},
): number {
  let logFd: number | undefined;
  if (options.logFile) {
    logFd = openSync(options.logFile, 'a');
  }
  const child = spawn(cmd, args, {
    detached: true,
    cwd: options.cwd,
    env: childEnv(options.env),
    stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
  });
  // detached:true alone still keeps the parent's event loop alive until
  // the child exits — without unref() the CLI would hang past its work
  // (run macos printed the "ready" summary and never exited). unref()
  // lets the CLI exit while the daemon (tart run, bridge forwarders,
  // qemu, watchdog) keeps running under its pid file.
  child.unref();
  return child.pid ?? -1;
}

/** Kills a process and all of its descendants (recursive
 *  pgrep -P).
 * @param pid - The root process id.
 * @param signal - Signal to send (default SIGTERM).
 */
export async function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (!isAlive(pid)) {
    return;
  }
  const out = await run('pgrep', ['-P', String(pid)]);
  for (const line of out.stdout.split('\n')) {
    const child = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(child) && child > 0) {
      await killTree(child, signal);
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/** Rejects when the promise does not settle in time (perl alarm
 *  equivalent — vmrun/getGuestIPAddress can hang past their own
 *  timeouts).
 * @param promise - The promise to race against the timer.
 * @param ms - Timeout in milliseconds.
 * @param message - Optional timeout error message.
 * @returns The promise's value when it settles in time.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message ?? `timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}
