import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandFailedError } from './exec.js';
import { runCheckedWithRetries, withRetries } from './retry.js';

describe('withRetries', () => {
  it('returns the first result without sleeping', async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await withRetries(
      async () => {
        calls += 1;
        return 'ok';
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('retries until the operation succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await withRetries(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error(`transient ${calls}`);
        }
        return 'ok';
      },
      {
        attempts: 4,
        delayMs: 100,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const waits: number[] = [];
    await expect(
      withRetries(
        async () => {
          throw new Error('down');
        },
        {
          attempts: 5,
          delayMs: 100,
          maxDelayMs: 250,
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
      ),
    ).rejects.toThrow('down');
    expect(waits).toEqual([100, 200, 250, 250]);
  });

  it('throws the last error after every attempt fails', async () => {
    const last = new Error('third');
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          throw calls === 3 ? last : new Error(`attempt ${calls}`);
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toBe(last);
    expect(calls).toBe(3);
  });

  it('defaults to three attempts', async () => {
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          throw new Error('down');
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow('down');
    expect(calls).toBe(3);
  });

  it('never retries an interrupted command', async () => {
    const interrupted = new CommandFailedError('command failed (143)', 143, 'SIGTERM');
    let calls = 0;
    await expect(
      withRetries(
        async () => {
          calls += 1;
          throw interrupted;
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBe(interrupted);
    expect(calls).toBe(1);
  });
});

describe('runCheckedWithRetries', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-retry-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('retries a real command that fails once', async () => {
    const marker = join(root, 'marker');
    const script = `if [ -f "${marker}" ]; then exit 0; fi; touch "${marker}"; exit 1`;
    await expect(
      runCheckedWithRetries('sh', ['-c', script], {}, { attempts: 3, delayMs: 0 }),
    ).resolves.toMatchObject({ code: 0 });
  });

  it('rejects with the command failure when every attempt fails', async () => {
    await expect(
      runCheckedWithRetries('sh', ['-c', 'exit 7'], {}, { attempts: 2, delayMs: 0 }),
    ).rejects.toThrow(/command failed \(7\)/);
  });

  it('does not retry an exit-code interrupt (130)', async () => {
    const count = join(root, 'count');
    const script = `printf x >> "${count}"; exit 130`;
    await expect(
      runCheckedWithRetries('sh', ['-c', script], {}, { attempts: 3, delayMs: 0 }),
    ).rejects.toThrow(/command failed \(130\)/);
    expect(readFileSync(count, 'utf8')).toBe('x');
  });
});
