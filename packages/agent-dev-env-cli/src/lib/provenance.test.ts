import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as provenance from './provenance.js';

// The record helpers resolve the data root from the environment at module
// load (lib/paths.ts paths.data). To keep the suite host-state-free the
// module is re-imported per test with AGENT_DEV_ENV_DATA_HOME pointing at
// a temp dir — records land there, never in the developer's real state.
let tmp: string;
let prov: typeof provenance;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'provenance-'));
  vi.stubEnv('AGENT_DEV_ENV_DATA_HOME', tmp);
  vi.resetModules();
  prov = await import('./provenance.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const PLATFORM = 'macos' as const;
const IMAGE = 'sandbox-macos-tahoe';
const INSTANCE = 'default-agent-dev-env';

describe('clone records', () => {
  it('writes and reads a fresh clone record', () => {
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'sandbox-macos',
      type: 'tart',
      name: IMAGE,
    });
    const record = prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE);
    expect(record?.platform).toBe(PLATFORM);
    expect(record?.image).toBe(IMAGE);
    expect(record?.instance).toBe(INSTANCE);
    expect(record?.vm).toBe('sandbox-macos');
    expect(record?.clonedFrom.type).toBe('tart');
    expect(record?.clonedFrom.name).toBe(IMAGE);
    expect(record?.clonedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('isolates instances with the same image', () => {
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: 'project-a',
      vm: 'sandbox-project-a',
      type: 'tart',
      name: IMAGE,
    });
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: 'project-b',
      vm: 'sandbox-project-b',
      type: 'tart',
      name: IMAGE,
    });
    expect(prov.readCloneRecord(PLATFORM, IMAGE, 'project-a')?.vm).toBe('sandbox-project-a');
    expect(prov.readCloneRecord(PLATFORM, IMAGE, 'project-b')?.vm).toBe('sandbox-project-b');
    expect(prov.readCloneRecord(PLATFORM, IMAGE, 'project-c')).toBeUndefined();
  });

  it('merges the image record into the clone record', () => {
    prov.writeImageRecord({
      platform: PLATFORM,
      image: IMAGE,
      registryRef: 'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
      digest: 'sha256:abc',
    });
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'v',
      type: 'qcow2',
      name: 'disk.qcow2',
    });
    const record = prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE);
    expect(record?.clonedFrom.registryRef).toBe('ghcr.io/ameshkov/sandbox-macos-tahoe:latest');
    expect(record?.clonedFrom.digest).toBe('sha256:abc');
  });

  it('explicit registry ref/digest win over the image record', () => {
    prov.writeImageRecord({
      platform: PLATFORM,
      image: IMAGE,
      registryRef: 'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
      digest: 'sha256:from-image',
    });
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'v',
      type: 'vmx',
      name: 'base.vmx',
      registryRef: 'ghcr.io/ameshkov/sandbox-macos-tahoe:1.6.0',
      digest: 'sha256:explicit',
    });
    expect(prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE)?.clonedFrom.digest).toBe(
      'sha256:explicit',
    );
  });

  it('backfill skips when a fresh record already exists', () => {
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'v',
      type: 'tart',
      name: IMAGE,
    });
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'v',
      type: 'tart',
      name: IMAGE,
      backfilled: true,
      clonedAt: '2026-08-19T00:00:00Z',
    });
    const record = prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE);
    expect(record?.clonedAt).not.toBe('2026-08-19T00:00:00Z');
    expect(record?.backfilled).toBeUndefined();
  });

  it('backfill writes when no record exists', () => {
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'v',
      type: 'qcow2',
      name: 'disk.qcow2',
      baseIdentity: '/x|1|2',
      backfilled: true,
      clonedAt: '2026-08-19T00:00:00Z',
    });
    const record = prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE);
    expect(record?.backfilled).toBe(true);
    expect(record?.clonedAt).toBe('2026-08-19T00:00:00Z');
    expect(record?.clonedFrom.baseIdentity).toBe('/x|1|2');
  });

  it('clearCloneRecord removes the record and the instance state dir (per instance)', () => {
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'v',
      type: 'tart',
      name: IMAGE,
    });
    prov.recordClone({
      platform: PLATFORM,
      image: IMAGE,
      instance: 'other',
      vm: 'w',
      type: 'tart',
      name: IMAGE,
    });
    prov.clearCloneRecord(PLATFORM, IMAGE, INSTANCE);
    expect(prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE)).toBeUndefined();
    expect(prov.readCloneRecord(PLATFORM, IMAGE, 'other')).toBeDefined();
    // The whole instance dir goes too — instance discovery (listInstances)
    // keys on directory presence, so a leftover empty dir would keep the
    // instance in `status` as "not created".
    expect(existsSync(dirname(prov.cloneRecordPath(PLATFORM, IMAGE, INSTANCE)))).toBe(false);
    expect(existsSync(dirname(prov.cloneRecordPath(PLATFORM, IMAGE, 'other')))).toBe(true);
  });

  it('returns undefined for a missing or corrupt record', () => {
    expect(prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE)).toBeUndefined();
    const path = prov.cloneRecordPath(PLATFORM, IMAGE, INSTANCE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json');
    expect(prov.readCloneRecord(PLATFORM, IMAGE, INSTANCE)).toBeUndefined();
  });
});

describe('image records', () => {
  it('writes and reads a pull record', () => {
    prov.writeImageRecord({
      platform: PLATFORM,
      image: IMAGE,
      registryRef: 'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
      digest: 'sha256:abc',
    });
    const record = prov.readImageRecord(PLATFORM, IMAGE);
    expect(record?.registryRef).toBe('ghcr.io/ameshkov/sandbox-macos-tahoe:latest');
    expect(record?.digest).toBe('sha256:abc');
    expect(record?.pulledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns undefined for a missing record', () => {
    expect(prov.readImageRecord(PLATFORM, IMAGE)).toBeUndefined();
  });
});

describe('formatting', () => {
  it('describes a clone record with registry info', () => {
    const line = prov.describeCloneRecord({
      schema: 1,
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'sandbox-macos',
      clonedFrom: {
        type: 'tart',
        name: IMAGE,
        registryRef: 'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
        digest: 'sha256:abc',
      },
      clonedAt: '2026-08-19T22:20:00Z',
    });
    expect(line).toContain('ghcr.io/ameshkov/sandbox-macos-tahoe:latest @ sha256:abc');
    expect(line).toContain('cloned 2026-08-19T22:20:00Z');
  });

  it('marks backfilled records in the line', () => {
    const line = prov.describeCloneRecord({
      schema: 1,
      platform: PLATFORM,
      image: IMAGE,
      instance: INSTANCE,
      vm: 'sandbox-macos',
      clonedFrom: { type: 'tart', name: IMAGE },
      clonedAt: '2026-08-19T22:20:00Z',
      backfilled: true,
    });
    expect(line).toContain('(backfilled)');
  });

  it('describes an image record', () => {
    const line = prov.describeImageRecord({
      schema: 1,
      platform: PLATFORM,
      image: IMAGE,
      registryRef: 'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
      digest: 'sha256:abc',
      pulledAt: '2026-09-02T13:00:00Z',
    });
    expect(line).toBe(
      'ghcr.io/ameshkov/sandbox-macos-tahoe:latest @ sha256:abc (pulled 2026-09-02T13:00:00Z)',
    );
  });

  it('exposes the missing-record constant', () => {
    expect(prov.CLONE_RECORD_MISSING).toContain('before provenance tracking');
  });
});

describe('parseDescriptorDigest', () => {
  it('parses the oras manifest descriptor output', () => {
    const out = JSON.stringify({
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: 'sha256:abc',
    });
    expect(prov.parseDescriptorDigest(out)).toBe('sha256:abc');
  });

  it('returns undefined for non-JSON or payloads without a digest', () => {
    expect(prov.parseDescriptorDigest('not json')).toBeUndefined();
    expect(prov.parseDescriptorDigest(JSON.stringify({ mediaType: 'x' }))).toBeUndefined();
  });
});
