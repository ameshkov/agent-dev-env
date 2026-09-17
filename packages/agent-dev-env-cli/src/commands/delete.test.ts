// commands/delete.test.ts — the pristine-cache policy of `delete`
// (--pristine vs the last-instance rule) and the instance-state step it
// builds on. Runs against a temp data root (AGENT_DEV_ENV_DATA_HOME), so
// nothing touches the developer's real state.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as deleteModule from './delete.js';
import type * as pathsModule from '../lib/paths.js';
import type * as provenanceModule from '../lib/provenance.js';

// The delete flows resolve the data root from the environment at module
// load (lib/paths.ts paths.data), so the modules are re-imported per test
// with AGENT_DEV_ENV_DATA_HOME pointing at a temp dir.
let tmp: string;
let del: typeof deleteModule;
let paths: typeof pathsModule;
let prov: typeof provenanceModule;

const PLATFORM = 'windows-vmware';
const IMAGE = 'sandbox-windows-11-arm64-vmware';
const INSTANCE = 'default-agent-dev-env';
const OTHER = 'project-b';

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'delete-'));
  vi.stubEnv('AGENT_DEV_ENV_DATA_HOME', tmp);
  vi.resetModules();
  del = await import('./delete.js');
  paths = await import('../lib/paths.js');
  prov = await import('../lib/provenance.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

/** Seeds an image root: the pulled archive, the extracted base and the
 *  provenance record (the pristine cache the policy removes).
 *
 * @returns The image root path.
 */
function seedPristine(): string {
  const root = paths.imageRootDir(PLATFORM, IMAGE);
  mkdirSync(join(root, 'image'), { recursive: true });
  mkdirSync(join(root, 'base'), { recursive: true });
  writeFileSync(join(root, 'image', `${IMAGE}.tar.gz`), 'archive');
  writeFileSync(join(root, 'base', `${IMAGE}.vmx`), 'vmx');
  prov.writeImageRecord({
    platform: PLATFORM,
    image: IMAGE,
    registryRef: `ghcr.io/ameshkov/${IMAGE}:latest`,
    digest: 'sha256:abc',
  });
  return root;
}

/** Seeds another instance's working state.
 *
 * @param instance - The instance name to seed.
 */
function seedInstance(instance: string): void {
  mkdirSync(paths.instanceDir(PLATFORM, IMAGE, instance), { recursive: true });
}

describe('applyPristinePolicy', () => {
  it('removes the cache with --pristine when no instance state existed', async () => {
    const root = seedPristine();
    await expect(del.applyPristinePolicy(PLATFORM, IMAGE, INSTANCE, 'absent', true)).resolves.toBe(
      true,
    );
    expect(existsSync(root)).toBe(false);
    expect(prov.readImageRecord(PLATFORM, IMAGE)).toBeUndefined();
  });

  it('keeps the cache without --pristine when there was no state to delete', async () => {
    const root = seedPristine();
    await expect(del.applyPristinePolicy(PLATFORM, IMAGE, INSTANCE, 'absent', false)).resolves.toBe(
      false,
    );
    expect(existsSync(root)).toBe(true);
  });

  it('drops the shared cache when the last instance was removed', async () => {
    const root = seedPristine();
    await expect(
      del.applyPristinePolicy(PLATFORM, IMAGE, INSTANCE, 'removed', false),
    ).resolves.toBe(true);
    expect(existsSync(root)).toBe(false);
  });

  it('keeps the shared cache while another instance remains', async () => {
    const root = seedPristine();
    seedInstance(OTHER);
    await expect(
      del.applyPristinePolicy(PLATFORM, IMAGE, INSTANCE, 'removed', false),
    ).resolves.toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('refuses the forced removal while another instance remains', async () => {
    const root = seedPristine();
    seedInstance(OTHER);
    await expect(del.applyPristinePolicy(PLATFORM, IMAGE, INSTANCE, 'absent', true)).resolves.toBe(
      false,
    );
    expect(existsSync(root)).toBe(true);
  });

  it('keeps the cache when the instance-state deletion was declined', async () => {
    const root = seedPristine();
    await expect(del.applyPristinePolicy(PLATFORM, IMAGE, INSTANCE, 'kept', true)).resolves.toBe(
      false,
    );
    expect(existsSync(root)).toBe(true);
  });
});

describe('deleteInstanceState', () => {
  it('reports absent when the state dir does not exist', async () => {
    const dir = paths.instanceDir(PLATFORM, IMAGE, INSTANCE);
    await expect(
      del.deleteInstanceState(
        PLATFORM,
        { image: IMAGE, instance: INSTANCE },
        dir,
        () => 'ask?',
        true,
      ),
    ).resolves.toBe('absent');
    expect(existsSync(dir)).toBe(false);
  });

  it('removes the state dir and its clone record with --yes', async () => {
    const dir = paths.instanceDir(PLATFORM, IMAGE, INSTANCE);
    mkdirSync(dir, { recursive: true });
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: join(dir, `${IMAGE}.vmx`),
      type: 'vmx',
      name: IMAGE,
    });
    await expect(
      del.deleteInstanceState(
        PLATFORM,
        { image: IMAGE, instance: INSTANCE },
        dir,
        () => 'ask?',
        true,
      ),
    ).resolves.toBe('removed');
    expect(existsSync(dir)).toBe(false);
    expect(prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE)).toBeUndefined();
  });
});
