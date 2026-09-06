import { describe, expect, it } from 'vitest';
import {
  findGuestNode,
  guestCredentials,
  nodeFromProbe,
  parseGuestStatus,
} from './ubuntu-guest.js';
import type { SshSession } from '../lib/ssh.js';

const VARS = {
  ssh_username: 'admin',
  ssh_password: 'sandbox1',
  image_version: '1.1.0',
} as const;

describe('guestCredentials', () => {
  it('reads the user and password from the vars file', () => {
    expect(guestCredentials(VARS, {}, '192.168.64.10')).toEqual({
      host: '192.168.64.10',
      port: 22,
      username: 'admin',
      password: 'sandbox1',
    });
  });

  it('UBUNTU_PASSWORD overrides the vars-file password', () => {
    const creds = guestCredentials(VARS, { UBUNTU_PASSWORD: 'changed' }, '192.168.64.10');
    expect(creds.password).toBe('changed');
  });

  it('falls back to the admin user when the vars file has none', () => {
    const creds = guestCredentials({ ssh_password: 'sandbox1' }, {}, '192.168.64.10');
    expect(creds.username).toBe('admin');
    expect(creds.password).toBe('sandbox1');
  });

  it('throws when no ssh_password is available anywhere', () => {
    expect(() => guestCredentials({}, {}, '192.168.64.10')).toThrow(/ssh_password/);
  });
});

describe('parseGuestStatus', () => {
  it('parses both bridge-status lines', () => {
    const output = 'bridge-status:ssh-agent=up\nbridge-status:docker=down\n';
    expect(parseGuestStatus(output)).toEqual({ sshAgent: true, docker: false });
  });

  it('reports only the lines that are present', () => {
    expect(parseGuestStatus('bridge-status:ssh-agent=up\n')).toEqual({ sshAgent: true });
    expect(parseGuestStatus('everything else')).toEqual({});
  });
});

describe('nodeFromProbe', () => {
  it('returns the absolute node path from a successful probe', () => {
    expect(
      nodeFromProbe({ code: 0, stdout: '/home/admin/.nvm/versions/node/v26.12.0/bin/node\n' }),
    ).toBe('/home/admin/.nvm/versions/node/v26.12.0/bin/node');
  });

  it('takes the last line when the probe printed several', () => {
    expect(
      nodeFromProbe({
        code: 0,
        stdout: '/usr/bin/node\n/home/admin/.nvm/versions/node/v26.12.0/bin/node\n',
      }),
    ).toBe('/home/admin/.nvm/versions/node/v26.12.0/bin/node');
  });

  it('returns undefined when the probe failed or printed nothing', () => {
    expect(nodeFromProbe({ code: 1, stdout: '' })).toBeUndefined();
    expect(nodeFromProbe({ code: 0, stdout: '' })).toBeUndefined();
    expect(nodeFromProbe({ code: 0, stdout: 'node not found\n' })).toBeUndefined();
  });
});

describe('findGuestNode', () => {
  it('tries the probes in order and returns the first node found', async () => {
    const probed: string[] = [];
    const session = fakeSession((command) => {
      probed.push(command);
      if (command === 'bash -ic "command -v node"') {
        return { code: 0, stdout: '/home/admin/.nvm/versions/node/v26.12.0/bin/node\n' };
      }
      return { code: 1, stdout: '' };
    });
    const node = await findGuestNode(session);
    expect(node).toBe('/home/admin/.nvm/versions/node/v26.12.0/bin/node');
    expect(probed.length).toBe(1);
  });

  it('falls back to the nvm install dir when a login shell misses node', async () => {
    const session = fakeSession((command) => {
      if (command.includes('nvm/versions/node')) {
        return { code: 0, stdout: '/home/admin/.nvm/versions/node/v26.12.0/bin/node\n' };
      }
      return { code: 1, stdout: '' };
    });
    const node = await findGuestNode(session);
    expect(node).toBe('/home/admin/.nvm/versions/node/v26.12.0/bin/node');
  });

  it('returns undefined when no probe finds a node', async () => {
    const session = fakeSession(() => ({ code: 1, stdout: '' }));
    expect(await findGuestNode(session)).toBeUndefined();
  });
});

/** A minimal fake session driving the probe commands (exec only).
 *
 * @param onExec - The per-command exec handler.
 * @returns The session.
 */
function fakeSession(onExec: (command: string) => { code: number; stdout: string }): SshSession {
  return {
    exec: (command: string) => Promise.resolve({ ...onExec(command), stderr: '' }),
    sftpWrite: () => Promise.resolve(),
    end: () => undefined,
  };
}
