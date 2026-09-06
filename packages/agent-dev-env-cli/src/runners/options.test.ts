import { describe, expect, it } from 'vitest';
import { parsePortEnv, resolveInstance, resolveRunOptions } from './options.js';

const DEFAULT = 'default-agent-dev-env';

const ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/test',
} as Record<string, string | undefined>;

describe('resolveRunOptions', () => {
  it('falls back to the platform defaults when nothing is set', () => {
    const options = resolveRunOptions('macos', {}, ENV, '/Users/test');
    expect(options.image).toBe('sandbox-macos-tahoe');
    expect(options.instance).toBe(DEFAULT);
    expect(options.workDir).toBe('/Volumes/dev');
    expect(options.mountName).toBe('dev');
    expect(options.agentPort).toBe(4100);
    expect(options.dockerPort).toBe(4101);
    expect(options.openchamberPort).toBe(4000);
    expect(options.cpuCount).toBe(8);
    expect(options.memoryMb).toBe(16384);
    expect(options.headless).toBe(false);
    expect(options.yes).toBe(false);
  });

  it('prefers flags over env over defaults', () => {
    const env = { ...ENV, SANDBOX_IMAGE: 'env-image', SANDBOX_VM: 'env-vm' };
    const options = resolveRunOptions('macos', { image: 'flag-image' }, env, '/Users/test');
    expect(options.image).toBe('flag-image');
    expect(options.instance).toBe('env-vm');
  });

  it('reads the SANDBOX_* overrides including ports', () => {
    const env = {
      ...ENV,
      SANDBOX_VM: 'my-project',
      SANDBOX_WORK_DIR: '/tmp/work',
      SANDBOX_MOUNT_NAME: 'work',
      SANDBOX_AGENT_PORT: '5100',
      SANDBOX_DOCKER_PORT: '5101',
      SANDBOX_MEMORY_MB: '8192',
    };
    const options = resolveRunOptions('macos', {}, env, '/Users/test');
    expect(options.instance).toBe('my-project');
    expect(options.workDir).toBe('/tmp/work');
    expect(options.mountName).toBe('work');
    expect(options.agentPort).toBe(5100);
    expect(options.dockerPort).toBe(5101);
    expect(options.memoryMb).toBe(8192);
  });

  it('resolves the instance on every platform', () => {
    expect(resolveRunOptions('windows-qemu', {}, ENV).instance).toBe(DEFAULT);
    expect(resolveRunOptions('windows-vmware', {}, ENV).instance).toBe(DEFAULT);
    expect(resolveRunOptions('ubuntu-vmware', {}, ENV).instance).toBe(DEFAULT);
    expect(resolveRunOptions('ubuntu-vmware', {}, { ...ENV, SANDBOX_VM: 'ci' }).instance).toBe(
      'ci',
    );
  });

  it('throws on an invalid SANDBOX_VM', () => {
    expect(() => resolveRunOptions('macos', {}, { ...ENV, SANDBOX_VM: 'Bad/Name' })).toThrow(
      /invalid SANDBOX_VM/,
    );
    expect(() => resolveRunOptions('macos', {}, { ...ENV, SANDBOX_VM: '..' })).toThrow(
      /invalid SANDBOX_VM/,
    );
  });

  it('resolves the forwarded ports (windows-qemu defaults + overrides)', () => {
    const options = resolveRunOptions('windows-qemu', {}, ENV, '/Users/test');
    expect(options.sshPort).toBe(2222);
    expect(options.rdpPort).toBe(3389);
    expect(options.winrmPort).toBe(5985);

    const env = {
      ...ENV,
      SANDBOX_SSH_PORT: '2200',
      SANDBOX_RDP_PORT: '3399',
      SANDBOX_WINRM_PORT: '6000',
    };
    const overridden = resolveRunOptions('windows-qemu', {}, env, '/Users/test');
    expect(overridden.sshPort).toBe(2200);
    expect(overridden.rdpPort).toBe(3399);
    expect(overridden.winrmPort).toBe(6000);
  });

  it('--work-dir flag wins over SANDBOX_WORK_DIR', () => {
    const env = { ...ENV, SANDBOX_WORK_DIR: '/env/dir' };
    expect(resolveRunOptions('macos', { workDir: '/flag/dir' }, env, '/Users/test').workDir).toBe(
      '/flag/dir',
    );
  });

  it('throws on an invalid port override', () => {
    expect(() => resolveRunOptions('macos', {}, { ...ENV, SANDBOX_AGENT_PORT: 'abc' })).toThrow(
      /invalid SANDBOX_AGENT_PORT port/,
    );
  });
});

describe('resolveInstance', () => {
  it('defaults to "default-agent-dev-env" when SANDBOX_VM is unset or empty', () => {
    expect(resolveInstance({})).toBe(DEFAULT);
    expect(resolveInstance({ SANDBOX_VM: '' })).toBe(DEFAULT);
    expect(resolveInstance({ SANDBOX_VM: '   ' })).toBe(DEFAULT);
  });

  it('accepts kebab-case instance names and rejects unsafe ones', () => {
    expect(resolveInstance({ SANDBOX_VM: 'my-project' })).toBe('my-project');
    expect(resolveInstance({ SANDBOX_VM: 'proj-1' })).toBe('proj-1');
    expect(() => resolveInstance({ SANDBOX_VM: 'Bad/Name' })).toThrow(/invalid SANDBOX_VM/);
    expect(() => resolveInstance({ SANDBOX_VM: '..' })).toThrow(/invalid SANDBOX_VM/);
    expect(() => resolveInstance({ SANDBOX_VM: '-leading-dash' })).toThrow(/invalid SANDBOX_VM/);
    expect(() => resolveInstance({ SANDBOX_VM: 'has.space' })).toThrow(/invalid SANDBOX_VM/);
  });
});

describe('parsePortEnv', () => {
  it('accepts a valid port and rejects an out-of-range one', () => {
    expect(parsePortEnv('4100', 'SANDBOX_AGENT_PORT')).toBe(4100);
    expect(() => parsePortEnv('70000', 'SANDBOX_AGENT_PORT')).toThrow(/expected 1-65535/);
    expect(() => parsePortEnv('0', 'SANDBOX_AGENT_PORT')).toThrow(/expected 1-65535/);
  });
});
