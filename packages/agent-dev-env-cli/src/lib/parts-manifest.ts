// lib/parts-manifest.ts — parsing the registry manifest of a chunked
// image artifact into the local PartsRecord. The manifest is the source
// of truth for the part names/sizes/digests (the pull fetches parts by
// digest); parseImageManifest enforces the chunked layout — every layer
// is a part, named part-NNNN in order — and rejects anything else with
// an actionable error (the previous single-layer layout is no longer
// supported).

import {
  PART_MEDIA_TYPE,
  QCOW2_ARTIFACT_TYPE,
  VMWARE_ARTIFACT_TYPE,
  partName,
  type PartInfo,
  type PartsKind,
  type PartsRecord,
} from './parts.js';

/** The OCI title annotation `oras push` derives from the pushed file
 *  name — the part file name on the pull side. */
const TITLE_ANNOTATION = 'org.opencontainers.image.title';

/** The subset of an OCI manifest the parser reads. */
interface ManifestLayer {
  mediaType?: unknown;
  digest?: unknown;
  size?: unknown;
  annotations?: unknown;
}

interface ImageManifest {
  artifactType?: unknown;
  layers?: unknown;
}

/** Parses a chunked image manifest (the `oras manifest fetch` output)
 *  into the parts record for the local cache.
 *
 * @param json - The parsed manifest JSON.
 * @param meta - The ref the manifest came from + its descriptor digest.
 * @returns The parts record (registryRef/manifestDigest set; the caller
 *   writes it to the parts directory).
 * @throws Error when the manifest is not a well-formed chunked image
 *   (single-layer/legacy layouts, wrong media types, non-contiguous
 *   part names, unknown artifact type).
 */
export function parseImageManifest(
  json: unknown,
  meta: { registryRef: string; manifestDigest: string },
): PartsRecord {
  const manifest = (typeof json === 'object' && json !== null ? json : {}) as ImageManifest;
  const artifactType = typeof manifest.artifactType === 'string' ? manifest.artifactType : '';
  const layers = Array.isArray(manifest.layers) ? (manifest.layers as ManifestLayer[]) : [];
  if (layers.length === 0) {
    throw new Error(`${meta.registryRef} has no image layers — is it an image artifact?`);
  }
  const parts = layers.map((layer, index) => parseLayer(layer, index, meta.registryRef));
  parts.sort((a, b) => a.name.localeCompare(b.name));
  const expected = parts.map((_, index) => partName(index)).join(', ');
  if (parts.map((part) => part.name).join(', ') !== expected) {
    throw new Error(
      `${meta.registryRef} is not a chunked image (single-layer or malformed manifest) — ` +
        'rebuild the image and push it again with the chunked layout',
    );
  }
  return {
    version: 1,
    kind: kindForArtifactType(artifactType, meta.registryRef),
    artifactType,
    registryRef: meta.registryRef,
    manifestDigest: meta.manifestDigest,
    partSize: Math.max(...parts.map((part) => part.size)),
    totalSize: parts.reduce((total, part) => total + part.size, 0),
    createdAt: new Date().toISOString(),
    parts,
  };
}

/** One part layer; throws when the layer is not a part (the error names
 *  the ref, never a bare layer dump). */
function parseLayer(layer: ManifestLayer, index: number, ref: string): PartInfo {
  const annotations =
    typeof layer.annotations === 'object' && layer.annotations !== null
      ? (layer.annotations as Record<string, unknown>)
      : {};
  const title = annotations[TITLE_ANNOTATION];
  if (
    layer.mediaType !== PART_MEDIA_TYPE ||
    typeof title !== 'string' ||
    !/^part-\d{4}$/.test(title) ||
    typeof layer.digest !== 'string' ||
    !layer.digest.startsWith('sha256:') ||
    typeof layer.size !== 'number' ||
    layer.size <= 0
  ) {
    throw new Error(
      `${ref} is not a chunked image (layer ${index} is not a part) — ` +
        'rebuild the image and push it again with the chunked layout',
    );
  }
  return { name: title, size: layer.size, digest: layer.digest };
}

/** The archive family of an artifact type. */
function kindForArtifactType(artifactType: string, ref: string): PartsKind {
  if (artifactType === VMWARE_ARTIFACT_TYPE) {
    return 'tar.gz';
  }
  if (artifactType === QCOW2_ARTIFACT_TYPE) {
    return 'qcow2';
  }
  throw new Error(`${ref} has an unsupported artifact type: ${artifactType || '(none)'}`);
}
