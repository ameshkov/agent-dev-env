import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PART_MEDIA_TYPE,
  QCOW2_ARTIFACT_TYPE,
  VMWARE_ARTIFACT_TYPE,
  type PartsRecord,
} from '../lib/parts.js';
import { resolveRequestedImages } from './catalog.js';
import { orasPushPartsArgs, pushWithRetries, tartPushArgs } from './deploy.js';

/** A minimal parts record for argv assertions. */
function partsRecord(): PartsRecord {
  return {
    version: 1,
    kind: 'tar.gz',
    artifactType: VMWARE_ARTIFACT_TYPE,
    registryRef: 'ghcr.io/me/img:1.2.0',
    manifestDigest: 'sha256:manifest',
    partSize: 512 * 1024 * 1024,
    totalSize: 3 * 512 * 1024 * 1024,
    createdAt: '2026-09-17T00:00:00.000Z',
    parts: [
      { name: 'part-0000', size: 512 * 1024 * 1024, digest: 'sha256:aaaa' },
      { name: 'part-0001', size: 512 * 1024 * 1024, digest: 'sha256:bbbb' },
      { name: 'part-0002', size: 512 * 1024 * 1024, digest: 'sha256:cccc' },
    ],
  };
}

describe('deploy arg builders', () => {
  it('tartPushArgs pushes both tags with 3 MB chunks', () => {
    expect(
      tartPushArgs('sandbox-macos-tahoe', 'ghcr.io/me/img:1.2.0', 'ghcr.io/me/img:latest'),
    ).toEqual([
      'push',
      'sandbox-macos-tahoe',
      '--chunk-size',
      '3',
      'ghcr.io/me/img:1.2.0',
      'ghcr.io/me/img:latest',
    ]);
  });

  it('orasPushPartsArgs pushes one layer per part, in order', () => {
    expect(
      orasPushPartsArgs('ghcr.io/me/img:1.2.0,latest', VMWARE_ARTIFACT_TYPE, partsRecord()),
    ).toEqual([
      'push',
      '--artifact-type',
      VMWARE_ARTIFACT_TYPE,
      '--concurrency',
      '5',
      'ghcr.io/me/img:1.2.0,latest',
      `part-0000:${PART_MEDIA_TYPE}`,
      `part-0001:${PART_MEDIA_TYPE}`,
      `part-0002:${PART_MEDIA_TYPE}`,
    ]);
  });

  it('orasPushPartsArgs keeps the QEMU artifact type', () => {
    const record = { ...partsRecord(), kind: 'qcow2' as const, artifactType: QCOW2_ARTIFACT_TYPE };
    const argv = orasPushPartsArgs('ghcr.io/me/img:latest', QCOW2_ARTIFACT_TYPE, record);
    expect(argv).toContain(QCOW2_ARTIFACT_TYPE);
    expect(argv.filter((arg) => arg.startsWith('part-'))).toHaveLength(3);
  });
});

describe('deploy target resolution', () => {
  it('resolves all catalog images when nothing is requested', () => {
    const targets = resolveRequestedImages();
    expect(targets.map((i) => i.name)).toContain('sandbox-macos-tahoe');
    expect(resolveRequestedImages(['sandbox-macos-tahoe'])).toHaveLength(1);
    expect(() => resolveRequestedImages(['nope'])).toThrow(/No vars file found/);
  });
});

describe('pushWithRetries', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-push-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('retries a push that fails once', async () => {
    const marker = join(root, 'marker');
    const script = `if [ -f "${marker}" ]; then exit 0; fi; touch "${marker}"; exit 1`;
    await expect(
      pushWithRetries('test push', 'sh', ['-c', script], {}, { delayMs: 0 }),
    ).resolves.toBeUndefined();
  });

  it('rejects with the last command failure when every attempt fails', async () => {
    await expect(
      pushWithRetries('test push', 'sh', ['-c', 'exit 7'], {}, { attempts: 2, delayMs: 0 }),
    ).rejects.toThrow(/command failed \(7\)/);
  });
});
