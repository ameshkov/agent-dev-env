// commands/doctor.test.ts — the free-disk check's sizing semantics: the
// real image size (the pulled footprint or the GHCR download) drives the
// check, and an undeterminable size is reported as unknown instead of
// failing the doctor run.

import { describe, expect, it } from 'vitest';
import { freeDiskCheck } from './doctor.js';

describe('freeDiskCheck', () => {
  it('passes when free space covers the pulled image footprint', () => {
    const check = freeDiskCheck(100, { bytes: 26e9, source: 'local' });
    expect(check.ok).toBe(true);
    expect(check.required).toBe(true);
    expect(check.unknown).toBeUndefined();
    expect(check.hint).toBe('free 100 GB vs 26 GB needed (pulled image footprint)');
  });

  it('fails when free space is below the GHCR download size', () => {
    const check = freeDiskCheck(5, { bytes: 8e9, source: 'registry' });
    expect(check.ok).toBe(false);
    expect(check.required).toBe(true);
    expect(check.hint).toBe('free 5 GB vs 8 GB needed (GHCR image download)');
  });

  it('reports unknown (never failing) when the image size is undeterminable', () => {
    const check = freeDiskCheck(100, undefined, 'no such host');
    expect(check.ok).toBe(false);
    expect(check.required).toBe(false);
    expect(check.unknown).toBe(true);
    expect(check.hint).toContain('no such host');
  });

  it('reports unknown when there is no catalog image to size', () => {
    const check = freeDiskCheck(100);
    expect(check.unknown).toBe(true);
    expect(check.hint).toContain('no image in the catalog');
  });

  it('shortens a long registry error for the table hint', () => {
    const check = freeDiskCheck(100, undefined, `Error: ${'x'.repeat(200)}`);
    expect(check.hint.length).toBeLessThan(160);
    expect(check.hint.endsWith('...')).toBe(true);
  });
});
