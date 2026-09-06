import { describe, expect, it } from 'vitest';
import {
  appendBlockIfMissing,
  dockerContextArgs,
  launchdPlist,
  removeBlock,
  sshConfigBlock,
  zprofileAgentBlock,
  zprofileDockerBlock,
  type LaunchdBridge,
} from './system.js';

const BRIDGE: LaunchdBridge = {
  label: 'dev.agent-dev-env.ssh-agent',
  nodePath: '/usr/local/bin/node',
  agentPath: '/Users/admin/.local/lib/agent-dev-env/guest-agent-mac.js',
  role: 'ssh-agent',
  port: 4100,
  hostAlias: '192.168.64.1',
};

const DOCKER_SOCKET = '/Users/admin/.docker/run/docker.sock';

describe('system builders (mac)', () => {
  it('launchdPlist renders the bridge as ProgramArguments with the host alias', () => {
    const plist = launchdPlist(BRIDGE, DOCKER_SOCKET);
    expect(plist).toContain('<key>Label</key><string>dev.agent-dev-env.ssh-agent</string>');
    expect(plist).toContain('<string>bridge</string>');
    expect(plist).toContain('<string>ssh-agent</string>');
    expect(plist).toContain('<string>--host-alias</string>');
    expect(plist).toContain('<string>192.168.64.1</string>');
    expect(plist).toContain('<string>unix:/tmp/ssh-agent.sock</string>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
  });

  it('launchdPlist embeds the resolved docker socket (no $HOME for launchd)', () => {
    const plist = launchdPlist({ ...BRIDGE, role: 'docker' }, DOCKER_SOCKET);
    expect(plist).toContain(`<string>unix:${DOCKER_SOCKET}</string>`);
    expect(plist).not.toContain('$HOME');
  });

  it('launchdPlist escapes XML special characters', () => {
    const plist = launchdPlist(
      {
        ...BRIDGE,
        agentPath: '/Users/a&b/agent.js',
        hostAlias: '10.0.2.2',
      },
      DOCKER_SOCKET,
    );
    expect(plist).toContain('/Users/a&amp;b/agent.js');
    expect(plist).not.toContain('a&b/');
  });

  it('dockerContextArgs wire the unix socket into the host context', () => {
    const args = dockerContextArgs('/opt/homebrew/bin/docker', DOCKER_SOCKET);
    expect(args).toHaveLength(3);
    expect(args[0][0]).toBe('/opt/homebrew/bin/docker');
    expect(args[0]).toContain(`host=unix://${DOCKER_SOCKET}`);
    expect(args[1]).toContain(`host=unix://${DOCKER_SOCKET}`);
    expect(args[2].slice(1)).toEqual(['context', 'use', 'host']);
  });

  it('zprofile blocks carry the markers the file-append logic reuses', () => {
    expect(zprofileAgentBlock()).toContain('export SSH_AUTH_SOCK=/tmp/ssh-agent.sock');
    expect(zprofileDockerBlock()).toContain(
      'export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"',
    );
    expect(zprofileDockerBlock()).toContain('TESTCONTAINERS_HOST_OVERRIDE');
  });

  it('ssh config block sets IdentityAgent', () => {
    expect(sshConfigBlock()).toContain('    IdentityAgent /tmp/ssh-agent.sock');
  });

  it('appendBlockIfMissing keeps the original content and is idempotent', () => {
    const block = zprofileAgentBlock();
    const marker = '# SSH agent bridge to the host (see docs/ssh-agent.md)';
    const original = 'export A=1\n';
    const once = appendBlockIfMissing(original, block, marker);
    expect(once).toContain('export A=1');
    expect(once).toContain(marker);
    const twice = appendBlockIfMissing(once, block, marker);
    expect(twice).toBe(once);
  });

  it('removeBlock removes the block but keeps surrounding content', () => {
    const original = 'export A=1\n' + zprofileAgentBlock() + 'export B=2\n';
    const cleaned = removeBlock(original, '# SSH agent bridge to the host (see docs/ssh-agent.md)');
    expect(cleaned).toContain('export A=1');
    expect(cleaned).toContain('export B=2');
    expect(cleaned).not.toContain('export SSH_AUTH_SOCK');
  });
});
