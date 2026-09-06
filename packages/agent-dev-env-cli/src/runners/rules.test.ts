import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadHostGlobalAgents, mergeAgentRules, renderAgentRules } from './rules.js';

const SAMPLE = [
  '# Sandbox VM environment',
  '',
  '## Paths',
  '',
  '- shared at `{{GUEST_MOUNT}}` (host `{{HOST_WORK_DIR}}`)',
  '',
  '## Docker',
  '',
  '- use the host engine',
  '',
  '## SSH agent bridge',
  '',
  '- the host agent is bridged',
  '',
  '',
].join('\n');

describe('renderAgentRules', () => {
  it('substitutes the work dir and guest mount', () => {
    const out = renderAgentRules(
      SAMPLE,
      { HOST_WORK_DIR: '/Volumes/dev', GUEST_MOUNT: '/Volumes/My Shared Files/dev' },
      true,
    );
    expect(out).toContain('`/Volumes/My Shared Files/dev`');
    expect(out).toContain('`/Volumes/dev`');
  });

  it('drops the SSH section when the agent bridge is not up', () => {
    const out = renderAgentRules(
      SAMPLE,
      { HOST_WORK_DIR: '/Volumes/dev', GUEST_MOUNT: '/Volumes/My Shared Files/dev' },
      false,
    );
    expect(out).not.toContain('SSH agent bridge');
    expect(out).toContain('use the host engine');
  });

  it('keeps the SSH section when the bridge is up', () => {
    const out = renderAgentRules(
      SAMPLE,
      { HOST_WORK_DIR: '/Volumes/dev', GUEST_MOUNT: '/Volumes/My Shared Files/dev' },
      true,
    );
    expect(out).toContain('## SSH agent bridge');
  });

  it('leaves an unknown token alone (sed parity)', () => {
    const out = renderAgentRules(
      SAMPLE,
      { HOST_WORK_DIR: '/Volumes/dev', GUEST_MOUNT: '/Volumes/My Shared Files/dev', EXTRA: 'x' },
      true,
    );
    // EXTRA is not in the text; the renderer must not invent tokens.
    expect(out).not.toContain('EXTRA');
  });
});

describe('loadHostGlobalAgents', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'host-agents-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns the host global AGENTS.md content when it exists', () => {
    const target = join(home, '.config', 'opencode', 'AGENTS.md');
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, '# Host rules\n');
    expect(loadHostGlobalAgents(home)).toBe('# Host rules\n');
  });

  it('returns empty when the host global AGENTS.md is missing', () => {
    expect(loadHostGlobalAgents(home)).toBe('');
  });
});

describe('mergeAgentRules', () => {
  const SANDBOX = '# Sandbox VM environment\n\n- use the host engine\n';

  it('prepends the host global instructions to the sandbox rules', () => {
    const out = mergeAgentRules('# Host rules\nline 2\n', SANDBOX);
    expect(out).toBe(
      '# Host rules\nline 2\n\n---\n\n# Sandbox VM environment\n\n- use the host engine\n',
    );
  });

  it('returns the sandbox rules alone when the host has no global rules', () => {
    expect(mergeAgentRules('', SANDBOX)).toBe(SANDBOX);
  });

  it('treats whitespace-only host content as absent', () => {
    expect(mergeAgentRules('  \n\n ', SANDBOX)).toBe(SANDBOX);
  });
});
