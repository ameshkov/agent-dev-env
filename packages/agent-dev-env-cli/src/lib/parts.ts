// lib/parts.ts — the chunked image-archive primitives. Big image
// archives (the VMware/Ubuntu tar.gz, the QEMU qcow2) are pushed to GHCR
// as N OCI layers; a single 22 GiB blob dies when the registry's signed
// download URL expires mid-transfer, while a 512 MiB part always fits
// inside the window and a retry only re-fetches the parts that are
// missing (no byte-level resume needed).
//
// A parts directory holds part-NNNN files plus parts.json (the record:
// kind, artifact type, registry ref/digest, per-part size + sha256). The
// parts concatenated in name order are byte-identical to the source
// archive, so the record alone is enough to reassemble and to detect
// missing/truncated parts.

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/** The fixed part size (512 MiB). A part must finish inside the
 *  registry's signed-URL window (roughly 5-10 minutes): 512 MiB takes
 *  ~30 s at 17 MB/s and ~3.5 min at 2.5 MB/s, while 1 GiB is already
 *  borderline on a slow link. */
export const PART_SIZE_BYTES = 512 * 1024 * 1024;

/** The OCI layer media type of every part (a fragment of a stream, not a
 *  standalone archive). */
export const PART_MEDIA_TYPE = 'application/vnd.agent-dev-env.image-part';

/** The VMware/Ubuntu artifact type (a chunked tar.gz of the VM dir). */
export const VMWARE_ARTIFACT_TYPE = 'application/vnd.agent-dev-env.vmware-vm';

/** The QEMU artifact type (a chunked, zstd-compressed qcow2). */
export const QCOW2_ARTIFACT_TYPE = 'application/vnd.agent-dev-env.qcow2';

/** The parts record file name (inside the parts directory). */
export const PARTS_RECORD_NAME = 'parts.json';

/** The local build-output verification marker name (the disks-at-root
 *  check ran for this chunk set). */
export const PARTS_VERIFIED_NAME = 'parts.verified';

/** The archive family a parts set reassembles into. */
export type PartsKind = 'tar.gz' | 'qcow2';

/** One part file. */
export interface PartInfo {
  /** The part file name (part-NNNN; lexicographic = stream order). */
  name: string;
  /** The part size in bytes. */
  size: number;
  /** The part content digest (sha256:...), as pushed. */
  digest: string;
}

/** The parts.json record: everything needed to reassemble an archive and
 *  to recognize its version. `registryRef`/`manifestDigest` are null for
 *  locally packed archives and set for pulled ones. */
export interface PartsRecord {
  version: 1;
  kind: PartsKind;
  artifactType: string;
  registryRef: string | null;
  manifestDigest: string | null;
  /** The nominal part size (the last part may be smaller). */
  partSize: number;
  /** The reassembled archive size in bytes. */
  totalSize: number;
  /** ISO 8601 record time. */
  createdAt: string;
  parts: PartInfo[];
}

/** The read chunk size (sync writes keep the next signal-yield point
 *  close, so a Ctrl+C during a long split stays responsive). */
const READ_CHUNK_BYTES = 4 * 1024 * 1024;

/** The part file name for an index (part-0000; zero-padded so the
 *  lexicographic order is the stream order). */
export function partName(index: number): string {
  return `part-${String(index).padStart(4, '0')}`;
}

/** The parts record path inside a parts directory. */
function recordPath(dir: string): string {
  return join(dir, PARTS_RECORD_NAME);
}

/** Writes the parts record (a plain overwrite; the record is small and
 *  always rewritten as a whole). */
export function writePartsRecord(dir: string, record: PartsRecord): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(recordPath(dir), `${JSON.stringify(record, null, 2)}\n`);
}

/** Reads the parts record, tolerating a missing or corrupt file (a
 *  broken record means "no usable chunk set", never a crash). */
export function readPartsRecord(dir: string): PartsRecord | undefined {
  const path = recordPath(dir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isPartsRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a value is a structurally valid parts record. */
function isPartsRecord(value: unknown): value is PartsRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<PartsRecord>;
  return (
    record.version === 1 &&
    (record.kind === 'tar.gz' || record.kind === 'qcow2') &&
    typeof record.artifactType === 'string' &&
    typeof record.partSize === 'number' &&
    typeof record.totalSize === 'number' &&
    record.totalSize > 0 &&
    Array.isArray(record.parts) &&
    record.parts.length > 0 &&
    record.parts.every(isPartInfo)
  );
}

function isPartInfo(value: unknown): value is PartInfo {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const part = value as Partial<PartInfo>;
  return (
    typeof part.name === 'string' &&
    /^part-\d{4}$/.test(part.name) &&
    typeof part.size === 'number' &&
    part.size > 0 &&
    typeof part.digest === 'string' &&
    part.digest.startsWith('sha256:')
  );
}

/** One part during a split: an open file + its running sha256. */
class PartSink {
  /** The bytes written to this part so far. */
  size = 0;
  private readonly fd: number;
  private readonly hash = createHash('sha256');
  private readonly tmp: string;

  constructor(
    private readonly dir: string,
    private readonly index: number,
  ) {
    this.tmp = join(dir, `${partName(index)}.tmp`);
    this.fd = openSync(this.tmp, 'w');
  }

  append(buffer: Buffer, offset: number, length: number): void {
    writeSync(this.fd, buffer, offset, length);
    this.hash.update(buffer.subarray(offset, offset + length));
    this.size += length;
  }

  finish(): PartInfo {
    closeSync(this.fd);
    const name = partName(this.index);
    renameSync(this.tmp, join(this.dir, name));
    return { name, size: this.size, digest: `sha256:${this.hash.digest('hex')}` };
  }

  /** Closes the file without renaming it (a failed split leaves only a
   *  .tmp that the next split overwrites). */
  abort(): void {
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
  }
}

/** Splits a file into fixed-size parts (writing parts.json once the
 *  parts are complete). The source is never buffered whole; the caller
 *  picks the part size only in tests (the default is the production
 *  512 MiB).
 *
 * @param source - The archive file to split.
 * @param dir - The parts directory (created when missing).
 * @param meta - The archive kind + artifact type recorded in parts.json.
 * @param partSize - The part size in bytes (default PART_SIZE_BYTES).
 * @returns The written parts record.
 * @throws Error when the source is empty, the part size is invalid, or
 *   the written bytes do not add up to the source size.
 */
export async function splitFileToParts(
  source: string,
  dir: string,
  meta: { kind: PartsKind; artifactType: string },
  partSize: number = PART_SIZE_BYTES,
): Promise<PartsRecord> {
  if (statSync(source).size === 0) {
    throw new Error(`cannot split an empty file: ${source}`);
  }
  if (!Number.isInteger(partSize) || partSize <= 0) {
    throw new Error(`invalid part size: ${partSize}`);
  }
  mkdirSync(dir, { recursive: true });
  const parts = await writeParts(source, dir, partSize);
  const record: PartsRecord = {
    version: 1,
    kind: meta.kind,
    artifactType: meta.artifactType,
    registryRef: null,
    manifestDigest: null,
    partSize: Math.max(...parts.map((part) => part.size)),
    totalSize: parts.reduce((total, part) => total + part.size, 0),
    createdAt: new Date().toISOString(),
    parts,
  };
  writePartsRecord(dir, record);
  return record;
}

/** Copies the source into rotating part files (the byte loop behind
 *  splitFileToParts) and verifies the written byte count.
 *
 * @param source - The file to split.
 * @param dir - The parts directory (must exist).
 * @param partSize - The part size in bytes.
 * @returns The part infos in stream order.
 * @throws Error when the written bytes do not add up to the source size.
 */
async function writeParts(source: string, dir: string, partSize: number): Promise<PartInfo[]> {
  const size = statSync(source).size;
  const handle = await open(source, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, partSize));
  const parts: PartInfo[] = [];
  let sink = new PartSink(dir, 0);
  let remaining = partSize;
  let total = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      let offset = 0;
      while (offset < bytesRead) {
        if (remaining === 0) {
          parts.push(sink.finish());
          sink = new PartSink(dir, parts.length);
          remaining = partSize;
        }
        const take = Math.min(remaining, bytesRead - offset);
        sink.append(buffer, offset, take);
        offset += take;
        remaining -= take;
        total += take;
      }
    }
  } catch (err) {
    sink.abort();
    throw err;
  } finally {
    await handle.close();
  }
  if (sink.size > 0) {
    parts.push(sink.finish());
  } else {
    sink.abort();
  }
  if (total !== size) {
    throw new Error(`split ${source}: wrote ${total} bytes, expected ${size}`);
  }
  return parts;
}

/** A stream yielding the parts in order (the concatenation is the
 *  original archive). Feed it to a child's stdin (tar -xzf -) or to a
 *  destination file (the QEMU assembly). */
export function createPartsReadStream(dir: string, parts: PartInfo[]): Readable {
  return Readable.from(
    (async function* readParts() {
      for (const part of parts) {
        for await (const chunk of createReadStream(join(dir, part.name))) {
          yield chunk as Buffer;
        }
      }
    })(),
  );
}

/** The version identity of a chunk set: the pulled manifest digest when
 *  available (strongest), otherwise a short hash over the part digests
 *  (locally packed archives). Used by the base-extraction and
 *  backing-image markers, so any change re-derives the dependent state. */
export function partsIdentity(record: PartsRecord): string {
  if (record.manifestDigest) {
    return record.manifestDigest;
  }
  const hash = createHash('sha256');
  for (const part of record.parts) {
    hash.update(`${part.name}:${part.digest}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The parts that are missing or have the wrong size (a killed fetch
 *  leaves a short file that the next run re-fetches). */
export function missingParts(dir: string, record: PartsRecord): PartInfo[] {
  return record.parts.filter((part) => {
    const path = join(dir, part.name);
    return !existsSync(path) || statSync(path).size !== part.size;
  });
}

/** Throws when any part is missing or truncated. */
export function assertPartsComplete(dir: string, record: PartsRecord): void {
  const missing = missingParts(dir, record);
  if (missing.length > 0) {
    throw new Error(
      `image parts incomplete in ${dir}: missing or truncated ${missing.map((part) => part.name).join(', ')}`,
    );
  }
}

/** Whether an existing chunk set matches the given sources (all parts
 *  present, and parts.json written after the newest source changed) —
 *  the "reuse instead of re-split" check for deploy and local packs. */
export function partsAreCurrent(sources: string[], dir: string): boolean {
  const record = readPartsRecord(dir);
  if (!record || missingParts(dir, record).length > 0) {
    return false;
  }
  let newest = 0;
  for (const source of sources) {
    if (!existsSync(source)) {
      return false;
    }
    newest = Math.max(newest, statSync(source).mtimeMs);
  }
  if (sources.length === 0) {
    return false;
  }
  return statSync(recordPath(dir)).mtimeMs >= newest;
}
