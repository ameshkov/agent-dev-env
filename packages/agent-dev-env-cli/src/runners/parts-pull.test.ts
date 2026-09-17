import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PART_MEDIA_TYPE, VMWARE_ARTIFACT_TYPE, readPartsRecord } from '../lib/parts.js';
import { pullImageParts, type ExecFn } from './parts-pull.js';

const REF = 'ghcr.io/me/sandbox:latest';
const MANIFEST_DIGEST = 'sha256:manifest';
const PART_A = 'sha256:aaaa';
const PART_B = 'sha256:bbbb';
const BODY: Record<string, Buffer> = {
  [PART_A]: Buffer.from('abcd'),
  [PART_B]: Buffer.from('efg'),
};

/** A part layer as oras pushes it. */
function partLayer(name: string, digest: string): unknown {
  return {
    mediaType: PART_MEDIA_TYPE,
    digest,
    size: BODY[digest]?.length ?? 0,
    annotations: { 'org.opencontainers.image.title': name },
  };
}

/** A fake oras: serves the manifest and writes blob payloads.
 *
 * @param calls - Collects the argv of every invocation.
 * @param failDigest - The chunk that fails.
 * @param failures - How many of its first attempts fail (default: all).
 */
function fakeExec(
  calls: string[][],
  failDigest?: string,
  failures = Number.POSITIVE_INFINITY,
): ExecFn {
  const failed = new Map<string, number>();
  return async (_cmd, args = []) => {
    calls.push(args);
    if (args.join(' ') === `manifest fetch --descriptor ${REF}`) {
      return { code: 0, stdout: JSON.stringify({ digest: MANIFEST_DIGEST }), stderr: '' };
    }
    if (args.join(' ') === `manifest fetch ${REF}`) {
      return {
        code: 0,
        stdout: JSON.stringify({
          artifactType: VMWARE_ARTIFACT_TYPE,
          layers: [partLayer('part-0000', PART_A), partLayer('part-0001', PART_B)],
        }),
        stderr: '',
      };
    }
    if (args[0] === 'blob' && args[1] === 'fetch') {
      const digest = (args[args.length - 1] ?? '').split('@')[1] ?? '';
      const output = args[args.indexOf('--output') + 1] ?? '';
      if (digest === failDigest && (failed.get(digest) ?? 0) < failures) {
        failed.set(digest, (failed.get(digest) ?? 0) + 1);
        return { code: 1, stdout: '', stderr: 'cut by the registry' };
      }
      writeFileSync(output, BODY[digest] ?? Buffer.alloc(0));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected oras call: ${args.join(' ')}` };
  };
}

describe('pullImageParts', () => {
  let root: string;
  let partsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-pull-'));
    partsDir = join(root, 'parts');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches every part and writes the record', async () => {
    const calls: string[][] = [];
    const record = await pullImageParts({ ref: REF, partsDir, exec: fakeExec(calls) });

    expect(record.manifestDigest).toBe(MANIFEST_DIGEST);
    expect(record.totalSize).toBe(7);
    expect(readPartsRecord(partsDir)?.parts).toEqual(record.parts);
    expect(readFileSync(join(partsDir, 'part-0000'), 'utf8')).toBe('abcd');
    expect(readFileSync(join(partsDir, 'part-0001'), 'utf8')).toBe('efg');
    expect(existsSync(join(partsDir, 'part-0000.tmp'))).toBe(false);
    const blobCalls = calls.filter((args) => args[0] === 'blob' && args[1] === 'fetch');
    expect(blobCalls).toHaveLength(2);
  });

  it('skips complete parts on a retry', async () => {
    await pullImageParts({ ref: REF, partsDir, exec: fakeExec([]) });
    const calls: string[][] = [];
    const record = await pullImageParts({ ref: REF, partsDir, exec: fakeExec(calls) });
    expect(record.parts).toHaveLength(2);
    expect(calls.filter((args) => args[0] === 'blob' && args[1] === 'fetch')).toHaveLength(0);
  });

  it('re-fetches only the truncated part', async () => {
    await pullImageParts({ ref: REF, partsDir, exec: fakeExec([]) });
    writeFileSync(join(partsDir, 'part-0001'), 'ef');
    const calls: string[][] = [];
    await pullImageParts({ ref: REF, partsDir, exec: fakeExec(calls) });
    const blobCalls = calls.filter((args) => args[0] === 'blob' && args[1] === 'fetch');
    expect(blobCalls).toHaveLength(1);
    expect(blobCalls[0].at(-1)).toContain(PART_B);
    expect(readFileSync(join(partsDir, 'part-0001'), 'utf8')).toBe('efg');
  });

  it('retries a transient chunk failure and then succeeds', async () => {
    const calls: string[][] = [];
    const record = await pullImageParts({
      ref: REF,
      partsDir,
      exec: fakeExec(calls, PART_A, 1),
      retry: { delayMs: 0 },
    });
    expect(readFileSync(join(partsDir, 'part-0000'), 'utf8')).toBe('abcd');
    const partACalls = calls.filter((args) => (args[args.length - 1] ?? '').endsWith(PART_A));
    expect(partACalls).toHaveLength(2);
    expect(record.parts).toHaveLength(2);
  });

  it('throws (and leaves no tmp file) when a part keeps failing', async () => {
    const calls: string[][] = [];
    await expect(
      pullImageParts({
        ref: REF,
        partsDir,
        exec: fakeExec(calls, PART_B),
        retry: { delayMs: 0 },
      }),
    ).rejects.toThrow(/failed to fetch part-0001: cut by the registry/);
    const partBCalls = calls.filter((args) => (args[args.length - 1] ?? '').endsWith(PART_B));
    expect(partBCalls).toHaveLength(4);
    expect(existsSync(join(partsDir, 'part-0001.tmp'))).toBe(false);
    expect(existsSync(join(partsDir, 'part-0000'))).toBe(true);
  });

  it('does not retry an interrupted chunk fetch', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args = []) => {
      calls.push(args);
      if (args.join(' ') === `manifest fetch --descriptor ${REF}`) {
        return { code: 0, stdout: JSON.stringify({ digest: MANIFEST_DIGEST }), stderr: '' };
      }
      if (args.join(' ') === `manifest fetch ${REF}`) {
        return {
          code: 0,
          stdout: JSON.stringify({
            artifactType: VMWARE_ARTIFACT_TYPE,
            layers: [partLayer('part-0000', PART_A), partLayer('part-0001', PART_B)],
          }),
          stderr: '',
        };
      }
      return { code: -1, stdout: '', stderr: 'interrupted', signal: 'SIGINT' };
    };
    await expect(
      pullImageParts({ ref: REF, partsDir, exec, retry: { delayMs: 0 } }),
    ).rejects.toThrow(/failed to fetch part-0000: interrupted/);
    const partACalls = calls.filter((args) => (args[args.length - 1] ?? '').endsWith(PART_A));
    expect(partACalls).toHaveLength(1);
  });

  it('rejects the legacy single-layer manifest', async () => {
    const exec: ExecFn = async (_cmd, args = []) => {
      if (args.includes('--descriptor')) {
        return { code: 0, stdout: JSON.stringify({ digest: MANIFEST_DIGEST }), stderr: '' };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          artifactType: VMWARE_ARTIFACT_TYPE,
          layers: [
            {
              mediaType: 'application/vnd.oci.image.layer.v1.tar',
              digest: 'sha256:legacy',
              size: 100,
              annotations: { 'org.opencontainers.image.title': 'sandbox.tar.gz' },
            },
          ],
        }),
        stderr: '',
      };
    };
    await expect(pullImageParts({ ref: REF, partsDir, exec })).rejects.toThrow(
      /not a chunked image/,
    );
  });

  it('bounds the number of in-flight fetches', async () => {
    const parts = Array.from({ length: 6 }, (_, index) => `part-${String(index).padStart(4, '0')}`);
    const bodies = new Map(parts.map((name, index) => [`sha256:p${index}`, Buffer.from('x')]));
    let active = 0;
    let peak = 0;
    const exec: ExecFn = async (_cmd, args = []) => {
      if (args.includes('--descriptor')) {
        return { code: 0, stdout: JSON.stringify({ digest: MANIFEST_DIGEST }), stderr: '' };
      }
      if (args[0] === 'manifest') {
        return {
          code: 0,
          stdout: JSON.stringify({
            artifactType: VMWARE_ARTIFACT_TYPE,
            layers: parts.map((name, index) => ({
              mediaType: PART_MEDIA_TYPE,
              digest: `sha256:p${index}`,
              size: 1,
              annotations: { 'org.opencontainers.image.title': name },
            })),
          }),
          stderr: '',
        };
      }
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const digest = (args[args.length - 1] ?? '').split('@')[1] ?? '';
      writeFileSync(
        args[args.indexOf('--output') + 1] ?? '',
        bodies.get(digest) ?? Buffer.alloc(0),
      );
      active -= 1;
      return { code: 0, stdout: '', stderr: '' };
    };
    await pullImageParts({ ref: REF, partsDir, exec, concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(readPartsRecord(partsDir)?.parts).toHaveLength(6);
  });
});
