import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QCOW2_ARTIFACT_TYPE, splitFileToParts, type PartsRecord } from '../lib/parts.js';
import { assembleQemuImage } from './qemu-image.js';

/** Deterministic, poorly-compressible bytes for a fixture. */
function bytes(length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    buffer[i] = (i * 17 + 5) % 251;
  }
  return buffer;
}

describe('assembleQemuImage', () => {
  let root: string;
  let partsDir: string;
  let record: PartsRecord;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-qemu-'));
    const source = join(root, 'source.qcow2');
    writeFileSync(source, bytes(2500));
    partsDir = join(root, 'parts');
    record = await splitFileToParts(
      source,
      partsDir,
      { kind: 'qcow2', artifactType: QCOW2_ARTIFACT_TYPE },
      1000,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reassembles the chunks into one byte-identical qcow2', async () => {
    const dest = join(root, 'image.qcow2');
    await assembleQemuImage(partsDir, record, dest);
    expect(readFileSync(dest)).toEqual(bytes(2500));
  });

  it('overwrites a partial assembly from a previous run', async () => {
    const dest = join(root, 'image.qcow2');
    writeFileSync(dest, 'truncated');
    await assembleQemuImage(partsDir, record, dest);
    expect(readFileSync(dest)).toEqual(bytes(2500));
  });

  it('throws when the assembled size does not match the record', async () => {
    const dest = join(root, 'image.qcow2');
    await expect(
      assembleQemuImage(partsDir, { ...record, totalSize: record.totalSize - 1 }, dest),
    ).rejects.toThrow(/expected/);
  });
});
