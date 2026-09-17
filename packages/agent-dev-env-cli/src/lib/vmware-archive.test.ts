import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './exec.js';
import {
  VMWARE_ARTIFACT_TYPE,
  createPartsReadStream,
  readPartsRecord,
  splitFileToParts,
  type PartsRecord,
} from './parts.js';
import {
  archiveHasRootDisks,
  ensureVmwareLocalParts,
  packVmwareArchiveParts,
  partsDirOf,
} from './vmware-archive.js';

/** Incompressible bytes (a tar of repeated 'x' compresses to almost
 *  nothing and cannot be split meaningfully). */
function bytes(length: number): Buffer {
  return randomBytes(length);
}

/** Seeds a minimal build output (vmx + nvram + one disk + a log). */
function seedOutput(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'img.vmx'), 'nvme0:0.filename = "disk.vmdk"');
  writeFileSync(join(dir, 'img.nvram'), bytes(64));
  writeFileSync(join(dir, 'img-1.vmdk'), bytes(4000));
  writeFileSync(join(dir, 'vmware.log'), 'x');
}

/** The tar listing of a reassembled parts set. */
async function listParts(partsDir: string, record: PartsRecord): Promise<string[]> {
  const res = await run('tar', ['-tzf', '-'], {
    stdin: createPartsReadStream(partsDir, record.parts),
  });
  expect(res.code).toBe(0);
  return res.stdout.split('\n').filter(Boolean);
}

describe('archiveHasRootDisks', () => {
  it('accepts top-level .vmdk members', () => {
    expect(archiveHasRootDisks(['img.vmx', 'img.nvram', 'disk.vmdk'])).toBe(true);
  });

  it('rejects .vmdk members nested under the build path (the corrupt-pack bug)', () => {
    expect(
      archiveHasRootDisks([
        'img.vmx',
        'img.nvram',
        'Users/ameshkov/Library/Application Support/agent-dev-env/build/ubuntu-vmware/output/disk.vmdk',
      ]),
    ).toBe(false);
  });

  it('accepts an archive listing without disks', () => {
    expect(archiveHasRootDisks(['img.vmx', 'img.nvram'])).toBe(true);
  });
});

describe('packVmwareArchiveParts', () => {
  let root: string;
  let outputDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-vmware-parts-'));
    outputDir = join(root, 'output');
    seedOutput(outputDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('packs vmx+nvram+vmdk (sorted, no logs) into chunks and deletes the tar', async () => {
    const record = await packVmwareArchiveParts(outputDir, 'img', 1024);
    expect(record.kind).toBe('tar.gz');
    expect(record.artifactType).toBe(VMWARE_ARTIFACT_TYPE);
    expect(record.parts.length).toBeGreaterThan(1);
    expect(record.totalSize).toBe(record.parts.reduce((total, part) => total + part.size, 0));
    expect(existsSync(join(outputDir, 'img.tar.gz'))).toBe(false);
    expect(readPartsRecord(partsDirOf(outputDir))?.parts).toEqual(record.parts);

    const members = (await listParts(partsDirOf(outputDir), record)).sort();
    expect(members).toEqual(['img-1.vmdk', 'img.nvram', 'img.vmx']);
    expect(members.some((member) => member.includes('/'))).toBe(false);
    expect(archiveHasRootDisks(members)).toBe(true);
  });

  it('is deterministic for the same build output', async () => {
    const first = await packVmwareArchiveParts(outputDir, 'img', 1024);
    const second = await packVmwareArchiveParts(outputDir, 'img', 1024);
    expect(second.parts).toEqual(first.parts);
  });
});

describe('ensureVmwareLocalParts', () => {
  let root: string;
  let outputDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-vmware-parts-'));
    outputDir = join(root, 'output');
    seedOutput(outputDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('packs on first use, verifies the layout and reuses the chunks afterwards', async () => {
    const first = await ensureVmwareLocalParts(outputDir, 'img');
    expect(existsSync(join(outputDir, 'parts.verified'))).toBe(true);
    const recordPath = join(partsDirOf(outputDir), 'parts.json');
    const before = statSync(recordPath).mtimeMs;

    const second = await ensureVmwareLocalParts(outputDir, 'img');
    expect(second.parts).toEqual(first.parts);
    expect(statSync(recordPath).mtimeMs).toBe(before);
  });

  it('re-packs a corrupt chunk set (disks stored under the build path) and marks it', async () => {
    // Reproduce the old bug: an absolute vmdk member lands under the
    // build path inside the archive. Split that tar into the parts dir
    // so the (unverified) chunks look current but are invalid.
    const badTar = join(root, 'bad.tar.gz');
    const disk = join(outputDir, 'img-1.vmdk');
    await run('tar', ['-czf', badTar, 'img.vmx', 'img.nvram', disk], { cwd: outputDir });
    await splitFileToParts(
      badTar,
      partsDirOf(outputDir),
      { kind: 'tar.gz', artifactType: VMWARE_ARTIFACT_TYPE },
      1024,
    );

    const record = await ensureVmwareLocalParts(outputDir, 'img');
    const members = await listParts(partsDirOf(outputDir), record);
    expect(archiveHasRootDisks(members)).toBe(true);
    expect(existsSync(join(outputDir, 'parts.verified'))).toBe(true);
  });
});
