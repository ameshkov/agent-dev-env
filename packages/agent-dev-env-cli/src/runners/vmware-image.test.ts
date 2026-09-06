import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../lib/exec.js';
import type { RunContext } from './framework.js';
import type { RunOptions } from './options.js';
import {
  archiveHasRootDisks,
  archiveIdentity,
  ensureLocalArchive,
  packVmwareLocalArchive,
  vmxDiskFiles,
} from './vmware-image-archive.js';

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

describe('archiveIdentity', () => {
  it('binds the path, size and mtime (seconds) into one marker', () => {
    expect(archiveIdentity('/tmp/image.tar.gz', 1234, 1_700_000_123_456)).toBe(
      '/tmp/image.tar.gz|1234|1700000123',
    );
  });

  it('detects a rebuild at the same path via size/mtime', () => {
    const first = archiveIdentity('/tmp/image.tar.gz', 1234, 1_700_000_000_000);
    const rebuilt = archiveIdentity('/tmp/image.tar.gz', 1235, 1_700_000_000_999);
    expect(rebuilt).not.toBe(first);
  });
});

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

describe('packVmwareLocalArchive', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-tar-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('packs vmx+nvram+vmdk with RELATIVE member names (the disks extract next to the vmx)', async () => {
    for (const file of ['img.vmx', 'img.nvram', 'img-1.vmdk', 'vmware.log']) {
      writeFileSync(join(root, file), 'x');
    }
    const artifact = join(root, 'img.tar.gz');
    const res = await packVmwareLocalArchive(root, 'img', artifact);
    expect(res.code).toBe(0);
    const listing = await run('tar', ['-tzf', artifact]);
    const members = listing.stdout.split('\n').filter(Boolean);
    expect(members.sort()).toEqual(['img-1.vmdk', 'img.nvram', 'img.vmx']);
    // the regression: absolute members would land inside the build path
    expect(members.some((member) => member.includes('/'))).toBe(false);
    const extract = join(root, 'extract');
    mkdirSync(extract);
    await run('tar', ['-xzf', artifact, '-C', extract]);
    expect(existsSync(join(extract, 'img-1.vmdk'))).toBe(true);
    expect(existsSync(join(extract, 'img.vmx'))).toBe(true);
  });
});

describe('ensureLocalArchive', () => {
  let root: string;
  let outputDir: string;
  let local: string;
  let marker: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-dev-env-tar-'));
    outputDir = join(root, 'output');
    mkdirSync(outputDir);
    for (const file of ['img.vmx', 'img.nvram', 'img-1.vmdk', 'vmware.log']) {
      writeFileSync(join(outputDir, file), 'x');
    }
    local = join(outputDir, 'img.tar.gz');
    marker = `${local}.verified`;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('packs the missing archive and records the verified marker', async () => {
    await ensureLocalArchive(outputDir, 'img', local);
    expect(existsSync(local)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    const stat = statSync(local);
    expect(readFileSync(marker, 'utf8').trim()).toBe(
      archiveIdentity(local, stat.size, stat.mtimeMs),
    );
  });

  it('does not re-pack an already-verified archive (marker matches the identity)', async () => {
    await ensureLocalArchive(outputDir, 'img', local);
    const before = statSync(local).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ensureLocalArchive(outputDir, 'img', local);
    expect(statSync(local).mtimeMs).toBe(before);
  });

  it('re-packs a corrupt archive (disks stored under the build path) and marks it', async () => {
    // reproduce the old bug: an absolute vmdk member lands under the
    // build path inside the archive
    const disk = join(outputDir, 'img-1.vmdk');
    await run('tar', ['-czf', local, 'img.vmx', 'img.nvram', disk], { cwd: outputDir });
    await ensureLocalArchive(outputDir, 'img', local);
    const listing = await run('tar', ['-tzf', local]);
    expect(archiveHasRootDisks(listing.stdout.split('\n').filter(Boolean))).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});
