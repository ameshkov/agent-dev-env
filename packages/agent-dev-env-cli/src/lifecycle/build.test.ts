import { describe, expect, it } from 'vitest';
import { resolveRequestedImages } from './catalog.js';

describe('build image resolution', () => {
  it('resolves all catalog images when nothing is requested', () => {
    const targets = resolveRequestedImages();
    expect(targets.length).toBeGreaterThanOrEqual(1);
    expect(targets.map((i) => i.name)).toContain('sandbox-macos-golden-gate');
  });

  it('resolves requested images by name in order', () => {
    const targets = resolveRequestedImages(['sandbox-macos-golden-gate']);
    expect(targets).toHaveLength(1);
    expect(targets[0].platform).toBe('macos');
  });

  it('throws the shell message for an unknown image', () => {
    expect(() => resolveRequestedImages(['nope'])).toThrow(/No vars file found for image 'nope'/);
  });
});
