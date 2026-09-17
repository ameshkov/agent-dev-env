import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../lib/exec.js';
import { VMWARE_ARTIFACT_TYPE, splitFileToParts } from '../lib/parts.js';
import type { RunContext } from './framework.js';
import type { RunOptions } from './options.js';
import { vmxDiskFiles } from './vmware-image-archive.js';

/** A minimal writable sink the confirm prompt can write to in tests. */
function outputSink(): { stream: PassThrough; written: () => string } {
  let text = '';
  const stream = new PassThrough();
  stream.write = (chunk: unknown) => {
    text += String(chunk);
    return true;
  };
  return { stream, written: () => text };
}

function inputStream(answer: string): PassThrough {
  const stream = new PassThrough();
  stream.end(answer);
  return stream;
}

/** Packs a minimal pristine VM (the image's vmx referencing a relative
 *  disk) and splits it into a chunked-image directory. */
async function seedChunkedImage(root: string, image: string): Promise<string> {
  const fixture = join(root, 'fixture');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, `${image}.vmx`), 'nvme0:0.filename = "disk.vmdk"');
  writeFileSync(join(fixture, 'disk.vmdk'), 'disk-bytes');
  const tarPath = join(fixture, 'image.tar.gz');
  const packed = await run('tar', ['-czf', tarPath, `${image}.vmx`, 'disk.vmdk'], {
    cwd: fixture,
  });
  expect(packed.code).toBe(0);
  const partsDir = join(root, 'parts');
  await splitFileToParts(
    tarPath,
    partsDir,
    { kind: 'tar.gz', artifactType: VMWARE_ARTIFACT_TYPE },
    1024,
  );
  return partsDir;
}

describe('vmxDiskFiles', () => {
  it('returns the disk filenames and skips the auto-detect cdrom', () => {
    const vmx = [
      'sata0:0.filename = "auto detect"',
      'sata0:0.present = "TRUE"',
      'nvme0:0.filename = "disk.vmdk"',
      'nvme0:1.filename = "data.vmdk"',
    ].join('\n');
    expect(vmxDiskFiles(vmx)).toEqual(['disk.vmdk', 'data.vmdk']);
  });

  it('ignores the non-disk .filename properties a real vmx carries', () => {
    const vmx = [
      'nvme0:0.filename = "disk.vmdk"',
      'sata0:0.filename = "auto detect"',
      'sound.filename = "-1"',
      'sound.present = "FALSE"',
      'vmxstats.filename = "sandbox-ubuntu-24-04-arm64-vmware.scoreboard"',
      'serial0.filename = ""',
      'parallel0.filename = ""',
      'replay.filename = ""',
    ].join('\n');
    expect(vmxDiskFiles(vmx)).toEqual(['disk.vmdk']);
  });
});

describe('shouldReextract', () => {
  const platform = 'ubuntu-vmware' as const;
  const image = 'sandbox-ubuntu-24-04-arm64-vmware';
  let tmp: string;
  // Re-imported per test so paths.data picks up the stubbed data home
  // (the module resolves the roots at load time).
  let mod: typeof import('./vmware-image-archive.js');

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-dev-env-reextract-'));
    vi.stubEnv('AGENT_DEV_ENV_DATA_HOME', tmp);
    vi.resetModules();
    mod = await import('./vmware-image-archive.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  function context(yes: boolean): RunContext {
    return { image, options: { platform, yes } as unknown as RunOptions } as RunContext;
  }

  function createInstance(name: string): void {
    mkdirSync(join(tmp, platform, image, 'working', name), { recursive: true });
  }

  it('re-extracts without asking when no working instances exist (nothing is lost)', async () => {
    await expect(mod.shouldReextract(context(false), platform, image)).resolves.toBe(true);
  });

  it('asks and keeps the previous image on decline (default no)', async () => {
    createInstance('default-agent-dev-env');
    const input = inputStream('n\n');
    const output = outputSink();
    await expect(
      mod.shouldReextract(context(false), platform, image, { input, output: output.stream }),
    ).resolves.toBe(false);
    expect(output.written()).toContain('Continue?');
  });

  it('asks and re-extracts (drops the working instances) on confirmation', async () => {
    createInstance('default-agent-dev-env');
    const input = inputStream('y\n');
    const output = outputSink();
    await expect(
      mod.shouldReextract(context(false), platform, image, { input, output: output.stream }),
    ).resolves.toBe(true);
  });

  it('with --yes accepts the default (no — keeps the previous image)', async () => {
    createInstance('default-agent-dev-env');
    await expect(mod.shouldReextract(context(true), platform, image)).resolves.toBe(false);
  });
});

describe('ensureVmwareArchive with a chunked-image override', () => {
  const platform = 'ubuntu-vmware' as const;
  const image = 'sandbox-ubuntu-24-04-arm64-vmware';
  let tmp: string;
  let mod: typeof import('./vmware-image-archive.js');

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agent-dev-env-chunks-'));
    vi.stubEnv('AGENT_DEV_ENV_DATA_HOME', tmp);
    vi.resetModules();
    mod = await import('./vmware-image-archive.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  function context(env: Record<string, string>): RunContext {
    return {
      image,
      instance: 'default-agent-dev-env',
      options: { platform, yes: false, env } as unknown as RunOptions,
    } as RunContext;
  }

  it('extracts the base from the chunks and records the identity marker', async () => {
    const partsDir = await seedChunkedImage(tmp, image);
    const dir = await mod.ensureVmwareArchive(
      platform,
      'UBUNTU_VMWARE_IMAGE',
      context({ UBUNTU_VMWARE_IMAGE: partsDir }),
    );
    expect(dir).toBe(partsDir);

    const baseDir = join(tmp, platform, image, 'base');
    expect(existsSync(join(baseDir, `${image}.vmx`))).toBe(true);
    expect(existsSync(join(baseDir, 'disk.vmdk'))).toBe(true);
    const marker = readFileSync(join(tmp, platform, image, 'base-archive.txt'), 'utf8').trim();
    expect(marker).toBe(mod.archivePartsIdentity(partsDir));
  });

  it('rejects an override directory that is not a chunked image', async () => {
    const plain = join(tmp, 'plain');
    mkdirSync(plain, { recursive: true });
    await expect(
      mod.ensureVmwareArchive(
        platform,
        'UBUNTU_VMWARE_IMAGE',
        context({ UBUNTU_VMWARE_IMAGE: plain }),
      ),
    ).rejects.toThrow(/chunked image directory/);
  });

  it('splits a local tar.gz override into cached chunks (the golden-image flow)', async () => {
    const archive = join(tmp, 'golden.tar.gz');
    const fixture = join(tmp, 'golden-src');
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, `${image}.vmx`), 'nvme0:0.filename = "disk.vmdk"');
    writeFileSync(join(fixture, 'disk.vmdk'), 'disk-bytes');
    const packed = await run('tar', ['-czf', archive, `${image}.vmx`, 'disk.vmdk'], {
      cwd: fixture,
    });
    expect(packed.code).toBe(0);

    const dir = await mod.ensureVmwareArchive(
      platform,
      'UBUNTU_VMWARE_IMAGE',
      context({ UBUNTU_VMWARE_IMAGE: archive }),
    );
    expect(dir).toBe(`${archive}.parts`);
    expect(existsSync(join(dir, 'parts.json'))).toBe(true);
    expect(existsSync(join(tmp, platform, image, 'base', 'disk.vmdk'))).toBe(true);

    // A second run reuses the split (no re-split of an unchanged archive).
    const recordPath = join(dir, 'parts.json');
    const before = readFileSync(recordPath, 'utf8');
    await mod.ensureVmwareArchive(
      platform,
      'UBUNTU_VMWARE_IMAGE',
      context({ UBUNTU_VMWARE_IMAGE: archive }),
    );
    expect(readFileSync(recordPath, 'utf8')).toBe(before);
  });
});
