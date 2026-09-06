import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAlive, killTree, run, sleep, spawnDetached, withTimeout } from './exec.js';

// Node scripts that keep running until SIGKILL'd.
const DAEMON = 'setInterval(() => {}, 1000)';
const DAEMON_WITH_STDOUT = `console.log('daemon up'); ${DAEMON}`;

/** Active child-process pids (the internal Node handle list). */
function activeChildPids(): number[] {
  const getActive = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles;
  if (!getActive) {
    return [];
  }
  return getActive()
    .filter((handle): handle is { pid: number } => {
      return typeof handle === 'object' && handle !== null && 'pid' in handle;
    })
    .map((handle) => handle.pid);
}

/** Polls until the probe returns true or the timeout passes. */
async function waitFor(probe: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) {
      return true;
    }
    await sleep(50);
  }
  return probe();
}

describe('spawnDetached', () => {
  const daemonPids: number[] = [];

  afterEach(async () => {
    for (const pid of daemonPids.splice(0)) {
      if (isAlive(pid)) {
        await killTree(pid, 'SIGKILL');
      }
    }
  });

  it('returns a live pid for a long-running daemon', () => {
    const pid = spawnDetached(process.execPath, ['-e', DAEMON]);
    daemonPids.push(pid);
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);
  });

  it('does not keep the parent waiting for the child (unref)', () => {
    const pid = spawnDetached(process.execPath, ['-e', DAEMON]);
    daemonPids.push(pid);
    expect(activeChildPids()).not.toContain(pid);
  });

  it('writes stdio to the log file while the daemon runs', async () => {
    const logFile = join(tmpdir(), `agent-dev-env-spawn-detached-${process.pid}.log`);
    const pid = spawnDetached(process.execPath, ['-e', DAEMON_WITH_STDOUT], { logFile });
    daemonPids.push(pid);
    const hasLog = await waitFor(() => {
      try {
        return readFileSync(logFile, 'utf8').includes('daemon up');
      } catch {
        return false;
      }
    });
    expect(hasLog).toBe(true);
  });
});

describe('killTree', () => {
  it('kills a process and its descendants', async () => {
    // Parent spawns a detached grandchild, then keeps itself alive.
    const parentScript =
      `const { spawn } = require('node:child_process'); ` +
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(DAEMON)}], ` +
      `{ detached: true, stdio: 'ignore' }); child.unref(); ${DAEMON}`;
    const parentPid = spawnDetached(process.execPath, ['-e', parentScript]);
    expect(isAlive(parentPid)).toBe(true);

    let childPid: number | undefined;
    await waitFor(() => {
      const res = spawnSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' });
      const pids = (res.stdout ?? '')
        .split('\n')
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      if (pids.length === 0) {
        return false;
      }
      childPid = pids[0];
      return true;
    });

    await killTree(parentPid, 'SIGKILL');
    expect(await waitFor(() => !isAlive(parentPid))).toBe(true);
    const childToCheck = childPid;
    expect(await waitFor(() => childToCheck === undefined || !isAlive(childToCheck))).toBe(true);
  });
});

/**
 * A node script that writes its pid to the probe file and then loops
 * forever, exiting 130 on SIGINT / 143 on SIGTERM (the default shell
 * exit codes) so a forward test can assert the signal reached it.
 */
function signalProbeScript(probeFile: string): string {
  return (
    `const fs = require('node:fs');` +
    `fs.writeFileSync(${JSON.stringify(probeFile)}, String(process.pid));` +
    `process.on('SIGINT', () => process.exit(130));` +
    `process.on('SIGTERM', () => process.exit(143));` +
    DAEMON
  );
}

describe('run signal forwarding', () => {
  const probeFiles: string[] = [];

  afterEach(async () => {
    // Kill any child left behind by a failed wait (the probe holds the pid).
    for (const file of probeFiles.splice(0)) {
      let pid: number | undefined;
      try {
        pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
      } catch {
        pid = undefined;
      }
      if (pid !== undefined && isAlive(pid)) {
        await killTree(pid, 'SIGKILL');
      }
    }
  });

  it('forwards the CLI SIGINT to the child (deploy/build cancel)', async () => {
    const probeFile = join(tmpdir(), `agent-dev-env-run-sigint-${process.pid}.probe`);
    probeFiles.push(probeFile);
    const result = run(process.execPath, ['-e', signalProbeScript(probeFile)]);
    expect(await waitFor(() => existsSync(probeFile))).toBe(true);
    process.emit('SIGINT');
    const res = await withTimeout(result, 5000, 'run() did not settle after SIGINT');
    expect(res.code).toBe(130);
  });

  it('forwards the CLI SIGTERM to the child', async () => {
    const probeFile = join(tmpdir(), `agent-dev-env-run-sigterm-${process.pid}.probe`);
    probeFiles.push(probeFile);
    const result = run(process.execPath, ['-e', signalProbeScript(probeFile)]);
    expect(await waitFor(() => existsSync(probeFile))).toBe(true);
    process.emit('SIGTERM');
    const res = await withTimeout(result, 5000, 'run() did not settle after SIGTERM');
    expect(res.code).toBe(143);
  });
});

describe('run stream option', () => {
  it('mirrors the child output to the CLI while still capturing it', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    try {
      const res = await run(process.execPath, ['-e', "console.log('streamed-line')"], {
        stream: true,
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('streamed-line');
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('streamed-line'));
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('captures without mirroring when stream is off', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    try {
      const res = await run(process.execPath, ['-e', "console.log('captured-line')"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('captured-line');
      const mirrored = writeSpy.mock.calls.some((args) => {
        return String(args[0]).includes('captured-line');
      });
      expect(mirrored).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('run git hook environment', () => {
  /** The git repo-scoped vars git exports for hooks (GIT_INDEX_FILE,
   *  GIT_DIR, ...) must never reach spawned children — a child `git`
   *  with an explicit `-C` would otherwise target the hook's repo. */
  const HOOK_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE'];

  it('strips inherited git repo env vars from the child', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of HOOK_VARS) {
      saved[key] = process.env[key];
      process.env[key] = 'should-not-leak';
    }
    try {
      const res = await run(process.execPath, [
        '-e',
        "console.log(process.env.GIT_DIR ?? 'unset', process.env.GIT_INDEX_FILE ?? 'unset')",
      ]);
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe('unset unset');
    } finally {
      for (const key of HOOK_VARS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  });
});
