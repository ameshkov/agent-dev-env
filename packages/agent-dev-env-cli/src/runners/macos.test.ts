import { describe, expect, it } from 'vitest';
import { resolveCloneSource } from './macos.js';

describe('resolveCloneSource', () => {
  it('prefers the local VM name when the image was imported locally', () => {
    const vms = new Map([
      ['sandbox-macos-tahoe', 'stopped'],
      ['ghcr.io/ameshkov/sandbox-macos-tahoe:latest', 'stopped'],
    ]);
    expect(resolveCloneSource(vms, 'sandbox-macos-tahoe', 'ameshkov')).toBe('sandbox-macos-tahoe');
  });

  it('resolves the staged OCI reference regardless of the owner', () => {
    const vms = new Map([['ghcr.io/ameshkov/sandbox-macos-tahoe:latest', 'stopped']]);
    expect(resolveCloneSource(vms, 'sandbox-macos-tahoe', 'someone-else')).toBe(
      'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
    );
  });

  it('falls back to the pull reference when the image is not present', () => {
    expect(resolveCloneSource(new Map(), 'sandbox-macos-tahoe', 'ameshkov')).toBe(
      'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
    );
  });

  it('ignores refs of other images and digest-only rows', () => {
    const vms = new Map([
      ['ghcr.io/cirruslabs/sandbox-other:latest', 'stopped'],
      ['ghcr.io/ameshkov/sandbox-macos-tahoe@sha256:abc', 'stopped'],
    ]);
    expect(resolveCloneSource(vms, 'sandbox-macos-tahoe', 'ameshkov')).toBe(
      'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
    );
  });
});
