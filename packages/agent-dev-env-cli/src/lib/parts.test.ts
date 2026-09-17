import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PART_MEDIA_TYPE,
  PART_SIZE_BYTES,
  PARTS_RECORD_NAME,
  QCOW2_ARTIFACT_TYPE,
  VMWARE_ARTIFACT_TYPE,
  assertPartsComplete,
  createPartsReadStream,
  missingParts,
  partName,
  partsAreCurrent,
  partsIdentity,
  readPartsRecord,
  splitFileToParts,
  type PartsRecord,
} from './parts.js';

/** Deterministic, poorly-compressible bytes for a fixture. */
function bytes(length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) {
    buffer[i] = (i * 31 + 7) % 251;
  }
  return buffer;
}

/** Reads a parts set back into one buffer. */
async function concatParts(dir: string, record: PartsRecord): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createPartsReadStream(dir, record.parts)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

describe('partName', () => {
  it('zero-pads the index so lexicographic order is stream order', () => {
    expect(partName(0)).toBe('part-0000');
    expect(partName(12)).toBe('part-0012');
    expect([partName(2), partName(10)].sort()).toEqual(['part-0002', 'part-0010']);
  });
});

describe('part constants', () => {
  it('uses 512 MiB parts and a vendor layer media type', () => {
    expect(PART_SIZE_BYTES).toBe(512 * 1024 * 1024);
    expect(PART_MEDIA_TYPE).toBe('application/vnd.agent-dev-env.image-part');
  });
});

describe('splitFileToParts', () => {
  let root: string;
  let source: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-parts-'));
    source = join(root, 'image.tar.gz');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('splits a file into fixed-size parts and reassembles it byte-identically', async () => {
    const payload = bytes(2500);
    writeFileSync(source, payload);
    const dir = join(root, 'parts');
    const record = await splitFileToParts(
      source,
      dir,
      { kind: 'tar.gz', artifactType: VMWARE_ARTIFACT_TYPE },
      1000,
    );

    expect(record.kind).toBe('tar.gz');
    expect(record.artifactType).toBe(VMWARE_ARTIFACT_TYPE);
    expect(record.registryRef).toBeNull();
    expect(record.manifestDigest).toBeNull();
    expect(record.totalSize).toBe(2500);
    expect(record.partSize).toBe(1000);
    expect(record.parts.map((part) => [part.name, part.size])).toEqual([
      ['part-0000', 1000],
      ['part-0001', 1000],
      ['part-0002', 500],
    ]);
    expect(record.parts.every((part) => part.digest.startsWith('sha256:'))).toBe(true);
    expect(readPartsRecord(dir)?.parts).toEqual(record.parts);
    expect(await concatParts(dir, record)).toEqual(payload);
  });

  it('does not add an empty trailing part when the size is an exact multiple', async () => {
    writeFileSync(source, bytes(2000));
    const record = await splitFileToParts(
      source,
      join(root, 'parts'),
      { kind: 'qcow2', artifactType: QCOW2_ARTIFACT_TYPE },
      1000,
    );
    expect(record.parts.map((part) => part.size)).toEqual([1000, 1000]);
  });

  it('leaves no .tmp files behind', async () => {
    writeFileSync(source, bytes(1500));
    const dir = join(root, 'parts');
    await splitFileToParts(
      source,
      dir,
      { kind: 'tar.gz', artifactType: VMWARE_ARTIFACT_TYPE },
      1000,
    );
    expect(existsSync(join(dir, 'part-0000.tmp'))).toBe(false);
    expect(existsSync(join(dir, 'part-0001.tmp'))).toBe(false);
  });

  it('rejects an empty source', async () => {
    writeFileSync(source, '');
    await expect(
      splitFileToParts(source, join(root, 'parts'), {
        kind: 'tar.gz',
        artifactType: VMWARE_ARTIFACT_TYPE,
      }),
    ).rejects.toThrow(/empty file/);
  });
});

describe('readPartsRecord', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-parts-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns undefined for a missing or corrupt record', () => {
    const dir = join(root, 'parts');
    expect(readPartsRecord(dir)).toBeUndefined();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, PARTS_RECORD_NAME), '{ not json');
    expect(readPartsRecord(dir)).toBeUndefined();
    writeFileSync(join(dir, PARTS_RECORD_NAME), JSON.stringify({ version: 1, parts: [] }));
    expect(readPartsRecord(dir)).toBeUndefined();
  });
});

describe('missingParts and assertPartsComplete', () => {
  let root: string;
  let record: PartsRecord;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-parts-'));
    const source = join(root, 'image.qcow2');
    writeFileSync(source, bytes(2500));
    record = await splitFileToParts(
      source,
      join(root, 'parts'),
      { kind: 'qcow2', artifactType: QCOW2_ARTIFACT_TYPE },
      1000,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports nothing for a complete set', () => {
    expect(missingParts(join(root, 'parts'), record)).toEqual([]);
    expect(() => assertPartsComplete(join(root, 'parts'), record)).not.toThrow();
  });

  it('reports a deleted part', () => {
    rmSync(join(root, 'parts', 'part-0001'));
    expect(missingParts(join(root, 'parts'), record).map((part) => part.name)).toEqual([
      'part-0001',
    ]);
    expect(() => assertPartsComplete(join(root, 'parts'), record)).toThrow(/part-0001/);
  });

  it('reports a truncated part', () => {
    writeFileSync(join(root, 'parts', 'part-0002'), 'short');
    expect(missingParts(join(root, 'parts'), record).map((part) => part.name)).toEqual([
      'part-0002',
    ]);
  });
});

describe('partsIdentity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-parts-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('prefers the pulled manifest digest', async () => {
    const source = join(root, 'image.tar.gz');
    writeFileSync(source, bytes(100));
    const record = await splitFileToParts(
      source,
      join(root, 'parts'),
      { kind: 'tar.gz', artifactType: VMWARE_ARTIFACT_TYPE },
      100,
    );
    expect(partsIdentity(record)).toMatch(/^sha256:/);
    expect(partsIdentity({ ...record, manifestDigest: 'sha256:manifest' })).toBe('sha256:manifest');
  });

  it('changes when a part digest changes', async () => {
    const source = join(root, 'image.tar.gz');
    writeFileSync(source, bytes(100));
    const record = await splitFileToParts(
      source,
      join(root, 'parts'),
      { kind: 'tar.gz', artifactType: VMWARE_ARTIFACT_TYPE },
      100,
    );
    const tampered: PartsRecord = {
      ...record,
      parts: record.parts.map((part) => ({ ...part, digest: 'sha256:0000' })),
    };
    expect(partsIdentity(tampered)).not.toBe(partsIdentity(record));
  });
});

describe('partsAreCurrent', () => {
  let root: string;
  let source: string;
  let dir: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-parts-'));
    source = join(root, 'image.tar.gz');
    dir = join(root, 'parts');
    writeFileSync(source, bytes(1500));
    await splitFileToParts(
      source,
      dir,
      { kind: 'tar.gz', artifactType: VMWARE_ARTIFACT_TYPE },
      1000,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a chunk set packed after the sources changed', () => {
    expect(partsAreCurrent([source], dir)).toBe(true);
  });

  it('rejects a source newer than the chunk set', () => {
    const future = new Date(Date.now() + 60_000);
    utimesSync(source, future, future);
    expect(partsAreCurrent([source], dir)).toBe(false);
  });

  it('rejects a chunk set with a missing part', () => {
    rmSync(join(dir, 'part-0001'));
    expect(partsAreCurrent([source], dir)).toBe(false);
    expect(statSync(join(dir, 'part-0000')).size).toBe(1000);
  });

  it('rejects a missing source', () => {
    expect(partsAreCurrent([join(root, 'nope')], dir)).toBe(false);
  });
});
