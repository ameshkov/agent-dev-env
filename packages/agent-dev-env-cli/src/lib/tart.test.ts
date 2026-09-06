import { describe, expect, it } from 'vitest';
import {
  dirArg,
  gatewayFromVmIp,
  guestAgentKickstartCommand,
  parseTartList,
  tartRunArgs,
  tartSetArgs,
} from './tart.js';

const LIST_OUTPUT = [
  'Source Name Disk Used Access Time State',
  'ghcr.io/ameshkov/sandbox-macos-tahoe:latest sandbox-macos-tahoe 160.0 50.0 Wed Aug 27 10:00:00 2025 stopped',
  'sandbox-macos-tahoe sandbox-macos 160.0 45.0 Wed Aug 28 09:00:00 2025 running',
  '',
].join('\n');

describe('parseTartList', () => {
  it('maps names to the last-column state and skips the header', () => {
    const vms = parseTartList(LIST_OUTPUT);
    expect(vms.get('sandbox-macos-tahoe')).toBe('stopped');
    expect(vms.get('sandbox-macos')).toBe('running');
    expect(vms.size).toBe(2);
  });

  it('returns an empty map for empty output', () => {
    expect(parseTartList('').size).toBe(0);
  });
});

describe('gatewayFromVmIp', () => {
  it('replaces the last octet with .1', () => {
    expect(gatewayFromVmIp('192.168.64.34')).toBe('192.168.64.1');
  });

  it('returns undefined for non-IPv4 values', () => {
    expect(gatewayFromVmIp('')).toBeUndefined();
    expect(gatewayFromVmIp('not-an-ip')).toBeUndefined();
  });
});

describe('tartRunArgs', () => {
  it('keeps the legacy flag order for windowed runs (capture keys)', () => {
    expect(tartRunArgs('sandbox-macos', { headless: false })).toEqual([
      'run',
      '--capture-system-keys',
      '--no-audio',
      'sandbox-macos',
    ]);
  });

  it('uses --no-graphics when headless', () => {
    expect(tartRunArgs('sandbox-macos', { headless: true })).toEqual([
      'run',
      '--no-graphics',
      '--no-audio',
      'sandbox-macos',
    ]);
  });

  it('places the --dir share before the VM name', () => {
    const args = tartRunArgs('sandbox-macos', {
      headless: false,
      dirArg: dirArg('dev', '/Volumes/dev'),
    });
    expect(args).toEqual([
      'run',
      '--capture-system-keys',
      '--no-audio',
      '--dir=dev:/Volumes/dev',
      'sandbox-macos',
    ]);
  });
});

describe('tartSetArgs', () => {
  it('formats the recommended-settings argv', () => {
    expect(tartSetArgs('sandbox-macos', 8, 16384)).toEqual([
      'set',
      'sandbox-macos',
      '--cpu',
      '8',
      '--memory',
      '16384',
      '--display',
      '1280x800',
      '--display-refit',
    ]);
  });
});

describe('dirArg', () => {
  it('joins mount name and host dir with :', () => {
    expect(dirArg('dev', '/Volumes/dev')).toBe('--dir=dev:/Volumes/dev');
  });
});

describe('guestAgentKickstartCommand', () => {
  it('kickstarts the guest agent unit in the running user GUI domain', () => {
    expect(guestAgentKickstartCommand()).toBe(
      'launchctl kickstart -k gui/$(id -u)/org.cirruslabs.tart-guest-agent',
    );
  });
});
