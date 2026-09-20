import { describe, expect, it } from 'vitest';
import {
  dirArg,
  gatewayFromVmIp,
  guestAgentKickstartCommand,
  parseTartList,
  parseTartListJson,
  tartRunArgs,
  tartSetArgs,
} from './tart.js';

// Real `tart list` output (Tart 2.32.x): columns are Source, Name, Disk,
// Size, Accessed, State — local rows are keyed by the VM name, OCI rows
// (images staged by `tart pull`) by the full registry reference.
const LIST_OUTPUT = [
  'Source Name Disk Size Accessed State',
  'local  sandbox-macos-tahoe 160 102 3 days ago stopped',
  'local  sandbox-macos 160 114 1 day ago running',
  'OCI    ghcr.io/ameshkov/sandbox-macos-tahoe:latest 140 87 1 day ago stopped',
  '',
].join('\n');

describe('parseTartList', () => {
  it('maps local names and OCI references to the last-column state', () => {
    const vms = parseTartList(LIST_OUTPUT);
    expect(vms.get('sandbox-macos-tahoe')).toBe('stopped');
    expect(vms.get('sandbox-macos')).toBe('running');
    expect(vms.get('ghcr.io/ameshkov/sandbox-macos-tahoe:latest')).toBe('stopped');
    expect(vms.size).toBe(3);
  });

  it('returns an empty map for empty output', () => {
    expect(parseTartList('').size).toBe(0);
  });
});

// `tart list --format json` rows (Tart 2.32.x): Size is the on-disk size
// in decimal GB, Disk the virtual disk size.
const LIST_JSON = JSON.stringify([
  {
    Source: 'local',
    Name: 'sandbox-macos-tahoe',
    Disk: 160,
    Size: 102,
    State: 'stopped',
    Running: false,
    Accessed: '2026-09-11T16:50:09Z',
  },
  {
    Source: 'OCI',
    Name: 'ghcr.io/ameshkov/sandbox-macos-tahoe:latest',
    Disk: 140,
    Size: 87,
    State: 'stopped',
    Running: false,
    Accessed: '2026-09-11T16:50:09Z',
  },
]);

describe('parseTartListJson', () => {
  it('maps VM names to on-disk sizes in bytes', () => {
    const sizes = parseTartListJson(LIST_JSON);
    expect(sizes.get('sandbox-macos-tahoe')).toBe(102e9);
    expect(sizes.get('ghcr.io/ameshkov/sandbox-macos-tahoe:latest')).toBe(87e9);
    expect(sizes.size).toBe(2);
  });

  it('skips rows without a usable name/size', () => {
    const sizes = parseTartListJson(
      JSON.stringify([{ Name: 'no-size' }, { Size: 5 }, { Name: 'zero', Size: 0 }]),
    );
    expect(sizes.size).toBe(0);
  });

  it('returns an empty map for unreadable output', () => {
    expect(parseTartListJson('not json').size).toBe(0);
    expect(parseTartListJson('{"Name":"x"}').size).toBe(0);
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
