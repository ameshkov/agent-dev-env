import { describe, expect, it } from 'vitest';
import {
  PART_MEDIA_TYPE,
  QCOW2_ARTIFACT_TYPE,
  VMWARE_ARTIFACT_TYPE,
  type PartsRecord,
} from './parts.js';
import { parseImageManifest } from './parts-manifest.js';

const REF = 'ghcr.io/me/sandbox:latest';
const DIGEST = 'sha256:manifest';

/** One part layer as oras pushes it (the title annotation carries the
 *  file name). */
function partLayer(name: string, size: number, digest: string): unknown {
  return {
    mediaType: PART_MEDIA_TYPE,
    digest,
    size,
    annotations: { 'org.opencontainers.image.title': name },
  };
}

/** Parses a manifest, failing the test when it throws. */
function parse(manifest: unknown): PartsRecord {
  return parseImageManifest(manifest, { registryRef: REF, manifestDigest: DIGEST });
}

describe('parseImageManifest', () => {
  it('parses a VMware chunks manifest into a tar.gz record', () => {
    const record = parse({
      artifactType: VMWARE_ARTIFACT_TYPE,
      layers: [
        partLayer('part-0000', 1000, 'sha256:aaaa'),
        partLayer('part-0001', 500, 'sha256:bbbb'),
      ],
    });
    expect(record.kind).toBe('tar.gz');
    expect(record.artifactType).toBe(VMWARE_ARTIFACT_TYPE);
    expect(record.registryRef).toBe(REF);
    expect(record.manifestDigest).toBe(DIGEST);
    expect(record.partSize).toBe(1000);
    expect(record.totalSize).toBe(1500);
    expect(record.parts).toEqual([
      { name: 'part-0000', size: 1000, digest: 'sha256:aaaa' },
      { name: 'part-0001', size: 500, digest: 'sha256:bbbb' },
    ]);
  });

  it('parses a QEMU chunks manifest into a qcow2 record', () => {
    const record = parse({
      artifactType: QCOW2_ARTIFACT_TYPE,
      layers: [partLayer('part-0000', 2048, 'sha256:cccc')],
    });
    expect(record.kind).toBe('qcow2');
  });

  it('sorts parts by name (layer order does not matter)', () => {
    const record = parse({
      artifactType: VMWARE_ARTIFACT_TYPE,
      layers: [
        partLayer('part-0001', 500, 'sha256:bbbb'),
        partLayer('part-0000', 1000, 'sha256:aaaa'),
      ],
    });
    expect(record.parts.map((part) => part.name)).toEqual(['part-0000', 'part-0001']);
  });

  it('rejects the legacy single-layer manifest with an actionable error', () => {
    expect(() =>
      parse({
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
    ).toThrow(/not a chunked image/);
  });

  it('rejects a manifest with a missing layer digest', () => {
    expect(() =>
      parse({ artifactType: VMWARE_ARTIFACT_TYPE, layers: [{ mediaType: PART_MEDIA_TYPE }] }),
    ).toThrow(/not a chunked image/);
  });

  it('rejects non-contiguous part names', () => {
    expect(() =>
      parse({
        artifactType: VMWARE_ARTIFACT_TYPE,
        layers: [
          partLayer('part-0000', 1000, 'sha256:aaaa'),
          partLayer('part-0002', 500, 'sha256:bbbb'),
        ],
      }),
    ).toThrow(/not a chunked image/);
  });

  it('rejects a manifest without layers', () => {
    expect(() => parse({ artifactType: VMWARE_ARTIFACT_TYPE })).toThrow(/no image layers/);
  });

  it('rejects an unknown artifact type', () => {
    expect(() =>
      parse({
        artifactType: 'application/vnd.example.thing',
        layers: [partLayer('part-0000', 1000, 'sha256:aaaa')],
      }),
    ).toThrow(/unsupported artifact type/);
  });
});
