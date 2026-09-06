import { describe, expect, it } from 'vitest';
import { profileDScript, systemdUnit, type SystemdBridge } from './systemd.js';
import { envBlockTargets, removeProfileBlock } from './index.js';

const BRIDGE: SystemdBridge = {
  unitName: 'agent-dev-env-ssh-agent.service',
  description: 'Agent Dev Env SSH agent bridge',
  nodePath: '/usr/bin/node',
  agentPath: '/home/admin/.local/lib/agent-dev-env/guest-agent-ubuntu.js',
  role: 'ssh-agent',
  port: 4400,
  hostAlias: '192.168.24.1',
  socket: '/tmp/ssh-agent.sock',
};

describe('systemd builders (ubuntu)', () => {
  it('systemdUnit renders the bridge as ExecStart', () => {
    const unit = systemdUnit(BRIDGE);
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=Agent Dev Env SSH agent bridge');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /home/admin/.local/lib/agent-dev-env/guest-agent-ubuntu.js bridge ssh-agent',
    );
    expect(unit).toContain('--host-alias 192.168.24.1');
    expect(unit).toContain('--listen unix:/tmp/ssh-agent.sock');
    expect(unit).toContain('--forward tcp:192.168.24.1:4400');
  });

  it('profileDScript exports the bridge env for every login shell', () => {
    const script = profileDScript('192.168.24.1');
    expect(script).toContain('# Agent dev env bridge env');
    expect(script).toContain('export SSH_AUTH_SOCK=/tmp/ssh-agent.sock');
    expect(script).toContain('export DOCKER_HOST=unix:///tmp/docker.sock');
    expect(script).toContain('export TESTCONTAINERS_HOST_OVERRIDE=192.168.24.1');
  });
});

describe('envBlockTargets', () => {
  it('lands in profile.d and the sudo caller bashrc when root', () => {
    expect(envBlockTargets(true, '/root', 'admin')).toEqual([
      '/etc/profile.d/agent-dev-env.sh',
      '/home/admin/.bashrc',
    ]);
  });

  it('lands in profile.d only when root without a sudo caller', () => {
    expect(envBlockTargets(true, '/root')).toEqual(['/etc/profile.d/agent-dev-env.sh']);
  });

  it('lands in the user profile and bashrc when not root', () => {
    expect(envBlockTargets(false, '/home/admin')).toEqual([
      '/home/admin/.profile',
      '/home/admin/.bashrc',
    ]);
  });
});

describe('removeProfileBlock', () => {
  it('removes the marker-guarded block and keeps the rest', () => {
    const original = 'export A=1\n' + profileDScript('192.168.24.1') + 'export B=2\n';
    const cleaned = removeProfileBlock(original);
    expect(cleaned).toContain('export A=1');
    expect(cleaned).toContain('export B=2');
    expect(cleaned).not.toContain('DOCKER_HOST');
  });

  it('leaves the file unchanged when the block is absent', () => {
    const content = 'export A=1\n';
    expect(removeProfileBlock(content)).toBe(content);
  });
});
