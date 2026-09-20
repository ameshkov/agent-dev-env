// lib/image-size.test.ts — the real image-size resolution: the GHCR
// layer sum, the pulled local footprint and the local-first precedence.
// The local paths resolve the data root from the environment at module
// load (lib/paths.ts paths.data), so the modules are re-imported per test
// with AGENT_DEV_ENV_DATA_HOME pointing at a temp dir.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as imageSize from './image-size.js';
import type * as pathsModule from './paths.js';
import type * as qemuModule from './qemu.js';

let tmp: string;
let size: typeof imageSize;
let paths: typeof pathsModule;
let qemu: typeof qemuModule;

const IMAGE = 'sandbox-ubuntu-24-04-arm64-vmware';
const PLATFORM = 'ubuntu-vmware' as const;
const REF = `ghcr.io/me/${IMAGE}:latest`;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'image-size-'));
  vi.stubEnv('AGENT_DEV_ENV_DATA_HOME', tmp);
  vi.resetModules();
  size = await import('./image-size.js');
  paths = await import('./paths.js');
  qemu = await import('./qemu.js');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

/** Writes a file of the given size, creating the parents. */
function writeBytes(path: string, bytes: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
}

/** A fake oras answering every manifest fetch with the given JSON. */
function fakeOras(
  manifest: unknown,
): (cmd: string, args?: string[]) => Promise<{ code: number; stdout: string; stderr: string }> {
  return async () => ({ code: 0, stdout: JSON.stringify(manifest), stderr: '' });
}

describe('sumManifestLayerBytes', () => {
  it('sums the layer sizes of a chunked image manifest', () => {
    expect(size.sumManifestLayerBytes({ layers: [{ size: 1000 }, { size: 500 }] })).toBe(1500);
  });

  it('sums the many layers of a Tart image the same way', () => {
    expect(size.sumManifestLayerBytes({ layers: [{ size: 7 }, { size: 3 }] })).toBe(10);
  });

  it('returns undefined when the manifest has no well-formed layers', () => {
    expect(size.sumManifestLayerBytes({})).toBeUndefined();
    expect(size.sumManifestLayerBytes({ layers: [] })).toBeUndefined();
    expect(size.sumManifestLayerBytes({ layers: [{ size: 0 }] })).toBeUndefined();
    expect(size.sumManifestLayerBytes({ layers: [{ digest: 'sha256:x' }] })).toBeUndefined();
    expect(size.sumManifestLayerBytes(null)).toBeUndefined();
  });
});

describe('pathBytes', () => {
  it('measures a file and a directory tree', () => {
    const file = join(tmp, 'disk.img');
    writeBytes(file, 8192);
    expect(size.pathBytes(file)).toBeGreaterThanOrEqual(8192);

    writeBytes(join(tmp, 'vm', 'disk.vmdk'), 4096);
    writeBytes(join(tmp, 'vm', 'nvram.bin'), 2048);
    expect(size.pathBytes(join(tmp, 'vm'))).toBeGreaterThanOrEqual(6144);
  });

  it('returns 0 for a missing path', () => {
    expect(size.pathBytes(join(tmp, 'missing'))).toBe(0);
  });
});

describe('localImageBytes', () => {
  it('sums the VMware chunks and the extracted base', async () => {
    writeBytes(join(paths.vmwarePartsDir(PLATFORM, IMAGE), 'part-0000'), 4096);
    writeBytes(join(paths.vmwareBaseDir(PLATFORM, IMAGE), `${IMAGE}.vmdk`), 8192);
    expect(await size.localImageBytes(PLATFORM, IMAGE)).toBeGreaterThanOrEqual(12288);
  });

  it('measures the QEMU pristine qcow2 and any chunk staging', async () => {
    writeBytes(qemu.qemuImagePath(IMAGE), 4096);
    writeBytes(join(qemu.qemuPartsDir(IMAGE), 'part-0000'), 2048);
    expect(await size.localImageBytes('windows-qemu', IMAGE)).toBeGreaterThanOrEqual(6144);
  });

  it('returns undefined when nothing is pulled', async () => {
    expect(await size.localImageBytes(PLATFORM, IMAGE)).toBeUndefined();
  });
});

describe('resolveImageSize', () => {
  it('prefers the pulled footprint over the registry', async () => {
    writeBytes(join(paths.vmwarePartsDir(PLATFORM, IMAGE), 'part-0000'), 4096);
    let fetched = false;
    const exec = async (): Promise<{ code: number; stdout: string; stderr: string }> => {
      fetched = true;
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const result = await size.resolveImageSize(PLATFORM, IMAGE, { ref: REF, exec });
    expect(result?.source).toBe('local');
    expect(result?.bytes).toBeGreaterThanOrEqual(4096);
    expect(fetched).toBe(false);
  });

  it('falls back to the GHCR layer sum when nothing is pulled', async () => {
    const result = await size.resolveImageSize(PLATFORM, IMAGE, {
      ref: REF,
      exec: fakeOras({ layers: [{ size: 1000 }, { size: 500 }] }),
    });
    expect(result).toEqual({ bytes: 1500, source: 'registry' });
  });

  it('returns undefined when nothing is pulled and no ref is given', async () => {
    expect(await size.resolveImageSize(PLATFORM, IMAGE)).toBeUndefined();
  });

  it('throws when the registry manifest cannot be read', async () => {
    const exec = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
      code: 1,
      stdout: '',
      stderr: 'denied',
    });
    await expect(
      size.resolveImageSize(PLATFORM, IMAGE, { ref: REF, exec, retry: { attempts: 1 } }),
    ).rejects.toThrow(/denied/);
  });

  it('throws when the manifest has no layers', async () => {
    await expect(
      size.resolveImageSize(PLATFORM, IMAGE, { ref: REF, exec: fakeOras({}) }),
    ).rejects.toThrow(/no image layers/);
  });
});
