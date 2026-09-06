import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as paths from './paths.js';

// listInstances/instanceDir resolve the data root from the environment at
// module load (paths.data). Re-import per test with AGENT_DEV_ENV_DATA_HOME
// pointing at a temp dir so the suite is host-state-free.
let tmp: string;
let p: typeof paths;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'paths-'));
  vi.stubEnv('AGENT_DEV_ENV_DATA_HOME', tmp);
  vi.resetModules();
  p = await import('./paths.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const HOME = '/home/tester';

describe('paths', () => {
  it('resolves macOS defaults', () => {
    const resolved = p.resolvePaths({ env: {}, home: HOME, platform: 'darwin' });
    expect(resolved.data).toBe(`${HOME}/Library/Application Support/agent-dev-env`);
    expect(resolved.logs).toBe(`${HOME}/Library/Logs/agent-dev-env`);
    expect(resolved.cache).toBe(`${HOME}/Library/Caches/agent-dev-env`);
  });

  it('resolves Linux defaults', () => {
    const resolved = p.resolvePaths({ env: {}, home: HOME, platform: 'linux' });
    expect(resolved.data).toBe(`${HOME}/.local/share/agent-dev-env`);
    expect(resolved.logs).toBe(`${HOME}/.local/state/agent-dev-env`);
    expect(resolved.cache).toBe(`${HOME}/.cache/agent-dev-env`);
  });

  it('honors XDG_* when set, on any OS', () => {
    const resolved = p.resolvePaths({
      env: {
        XDG_DATA_HOME: '/xdg/data',
        XDG_STATE_HOME: '/xdg/state',
        XDG_CACHE_HOME: '/xdg/cache',
      },
      home: HOME,
      platform: 'linux',
    });
    expect(resolved.data).toBe('/xdg/data');
    expect(resolved.logs).toBe('/xdg/state');
    expect(resolved.cache).toBe('/xdg/cache');

    const darwin = p.resolvePaths({
      env: { XDG_DATA_HOME: '/xdg/data' },
      home: HOME,
      platform: 'darwin',
    });
    expect(darwin.data).toBe('/xdg/data');
    expect(darwin.logs).toBe(`${HOME}/Library/Logs/agent-dev-env`);
  });

  it('AGENT_DEV_ENV_* overrides XDG_*', () => {
    const resolved = p.resolvePaths({
      env: {
        AGENT_DEV_ENV_DATA_HOME: '/ade/data',
        AGENT_DEV_ENV_LOG_DIR: '/ade/logs',
        AGENT_DEV_ENV_CACHE_DIR: '/ade/cache',
        XDG_DATA_HOME: '/xdg/data',
        XDG_STATE_HOME: '/xdg/state',
        XDG_CACHE_HOME: '/xdg/cache',
      },
      home: HOME,
      platform: 'darwin',
    });
    expect(resolved.data).toBe('/ade/data');
    expect(resolved.logs).toBe('/ade/logs');
    expect(resolved.cache).toBe('/ade/cache');
  });

  it('empty values fall back (no empty-string overrides)', () => {
    const resolved = p.resolvePaths({
      env: {
        AGENT_DEV_ENV_DATA_HOME: '',
        XDG_DATA_HOME: '',
      },
      home: HOME,
      platform: 'linux',
    });
    expect(resolved.data).toBe(`${HOME}/.local/share/agent-dev-env`);
  });
});

describe('instance paths', () => {
  const instance = 'default-agent-dev-env';

  it('scopes the working vmx under working/<instance>/', () => {
    const root = join(tmp, 'ubuntu-vmware', 'sandbox-ubuntu-24-04-arm64-vmware');
    expect(p.workingVmxPath('ubuntu-vmware', 'sandbox-ubuntu-24-04-arm64-vmware', instance)).toBe(
      join(root, 'working', instance, 'sandbox-ubuntu-24-04-arm64-vmware.vmx'),
    );
    expect(p.workingVmxPath('ubuntu-vmware', 'sandbox-ubuntu-24-04-arm64-vmware', 'ci')).toBe(
      join(root, 'working', 'ci', 'sandbox-ubuntu-24-04-arm64-vmware.vmx'),
    );
  });

  it('lists the instances with working state (sorted)', () => {
    const root = join(tmp, 'windows-qemu', 'sandbox-windows-11-arm64-qemu', 'working');
    mkdirSync(join(root, instance), { recursive: true });
    mkdirSync(join(root, 'project-a'), { recursive: true });
    mkdirSync(join(root, 'project-b'), { recursive: true });

    expect(p.listInstances('windows-qemu', 'sandbox-windows-11-arm64-qemu')).toEqual([
      instance,
      'project-a',
      'project-b',
    ]);
  });

  it('returns an empty list when no instance state exists', () => {
    expect(p.listInstances('macos', 'sandbox-macos-tahoe')).toEqual([]);
  });

  it('ignores stray files under working/', () => {
    const root = join(tmp, 'macos', 'sandbox-macos-tahoe', 'working');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'backing-image.txt'), 'x');
    expect(p.listInstances('macos', 'sandbox-macos-tahoe')).toEqual([]);
  });
});
