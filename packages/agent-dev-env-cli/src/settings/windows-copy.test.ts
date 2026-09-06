import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as common from './common.js';
import { stageFile, stageGitconfig } from './windows-copy.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A host-home fixture with the opencode config, a VS Code settings file
 *  and a .gitconfig containing a host home path. */
function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'settings-home-'));
  mkdirSync(join(home, '.config/opencode'), { recursive: true });
  mkdirSync(join(home, 'Library/Application Support/Code/User'), { recursive: true });
  writeFileSync(join(home, '.config/opencode/opencode.json'), '{}\n');
  writeFileSync(join(home, 'Library/Application Support/Code/User/settings.json'), '{}\n');
  writeFileSync(
    join(home, '.gitconfig'),
    `helper = ${home}/.ssh/helper.sh\n[user]\n\tname = tester\n`,
  );
  return home;
}

describe('stageFile', () => {
  it('stages a same-path candidate (opencode config)', () => {
    const home = fixtureHome();
    const tree = mkdtempSync(join(tmpdir(), 'settings-tree-'));

    expect(stageFile(home, tree, '.config/opencode/opencode.json')).toBe(true);
    expect(readFileSync(join(tree, '.config/opencode/opencode.json'), 'utf8')).toBe('{}\n');
  });

  it('stages the VS Code path under the Windows AppData layout', () => {
    const home = fixtureHome();
    const tree = mkdtempSync(join(tmpdir(), 'settings-tree-'));

    expect(stageFile(home, tree, 'Library/Application Support/Code/User/settings.json')).toBe(true);
    expect(readFileSync(join(tree, 'AppData/Roaming/Code/User/settings.json'), 'utf8')).toBe(
      '{}\n',
    );
  });

  it('reports false and continues when the source is missing', () => {
    const home = fixtureHome();
    const tree = mkdtempSync(join(tmpdir(), 'settings-tree-'));

    expect(stageFile(home, tree, '.config/opencode/missing.json')).toBe(false);
  });
});

describe('stageGitconfig', () => {
  it('stages the sanitized content (host home rewritten to C:/Users/<user>)', () => {
    const home = fixtureHome();
    const tree = mkdtempSync(join(tmpdir(), 'settings-tree-'));

    expect(stageGitconfig(home, tree, 'Administrator')).toBe(true);
    expect(readFileSync(join(tree, '.gitconfig'), 'utf8')).toBe(
      `helper = C:/Users/Administrator/.ssh/helper.sh\n[user]\n\tname = tester\n`,
    );
  });

  it('ships the raw file as-is when sanitization fails', () => {
    const home = fixtureHome();
    const tree = mkdtempSync(join(tmpdir(), 'settings-tree-'));
    vi.spyOn(common, 'sanitizeGitconfig').mockImplementation(() => {
      throw new Error('parse failed');
    });

    expect(stageGitconfig(home, tree, 'Administrator')).toBe(true);
    expect(readFileSync(join(tree, '.gitconfig'), 'utf8')).toContain('name = tester');
  });

  it('reports false when the host has no .gitconfig', () => {
    const home = mkdtempSync(join(tmpdir(), 'settings-home-'));
    const tree = mkdtempSync(join(tmpdir(), 'settings-tree-'));

    expect(stageGitconfig(home, tree, 'Administrator')).toBe(false);
  });
});
