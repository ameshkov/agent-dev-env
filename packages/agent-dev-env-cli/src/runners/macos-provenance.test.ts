import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContext } from '../commands/run.js';
import { resolveRunOptions } from './options.js';

// The provenance helpers resolve the data root at module load; this suite
// stubs AGENT_DEV_ENV_DATA_HOME to a temp dir and re-imports the modules
// so records land there, never in the developer's real state dir.
let tmp: string;
let prov: typeof import('../lib/provenance.js');
let macosProv: typeof import('./macos-provenance.js');

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'macos-provenance-'));
  vi.stubEnv('AGENT_DEV_ENV_DATA_HOME', tmp);
  vi.resetModules();
  prov = await import('../lib/provenance.js');
  macosProv = await import('./macos-provenance.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function context(
  home: string = join(tmp, 'home'),
): Parameters<typeof macosProv.backfillMacosClone>[0] {
  const options = resolveRunOptions('macos', {}, {}, home);
  return buildContext(options);
}

describe('tartVmConfigPath', () => {
  it('builds the tart store path under the given home', () => {
    expect(macosProv.tartVmConfigPath('sandbox-macos', '/home/x')).toBe(
      '/home/x/.tart/vms/sandbox-macos/config.json',
    );
  });
});

describe('cloneTimeFromConfig', () => {
  it('returns the config mtime as ISO time', () => {
    const dir = mkdtempSync(join(tmp, 'tart-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, '{}');
    const expected = new Date(statSync(path).mtimeMs).toISOString();
    expect(macosProv.cloneTimeFromConfig(path)).toBe(expected);
  });

  it('returns undefined for a missing config', () => {
    expect(macosProv.cloneTimeFromConfig(join(tmp, 'no-such.json'))).toBeUndefined();
  });
});

describe('backfillMacosClone', () => {
  const INSTANCE = 'default-agent-dev-env';

  it('records the clone with the approximated clone time', () => {
    const storeHome = join(tmp, 'store-home');
    mkdirSync(join(storeHome, '.tart', 'vms', INSTANCE), { recursive: true });
    const config = join(storeHome, '.tart', 'vms', INSTANCE, 'config.json');
    writeFileSync(config, '{}');
    const expected = new Date(statSync(config).mtimeMs).toISOString();

    macosProv.backfillMacosClone(context(storeHome));

    const record = prov.readCloneRecord('macos', 'sandbox-macos-tahoe', INSTANCE);
    expect(record?.backfilled).toBe(true);
    expect(record?.clonedAt).toBe(expected);
  });

  it('records a backfilled clone without a clone time when config is missing', () => {
    macosProv.backfillMacosClone(context(join(tmp, 'no-store')));

    const record = prov.readCloneRecord('macos', 'sandbox-macos-tahoe', INSTANCE);
    expect(record?.backfilled).toBe(true);
    expect(record?.clonedAt).toBeUndefined();
  });
});
