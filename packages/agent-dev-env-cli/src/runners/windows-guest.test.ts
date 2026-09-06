import { describe, expect, it } from 'vitest';
import type { SshSession } from '../lib/ssh.js';
import {
  encodePsCommand,
  ensureGuestAgent,
  findGuestNode,
  guestCredentials,
  stripSentinel,
} from './windows-guest.js';

const VARS = {
  winrm_username: 'Administrator',
  winrm_password: 'sandbox1',
  image_version: '1.0.0',
} as const;

describe('guestCredentials', () => {
  it('reads the user and password from the vars file', () => {
    expect(guestCredentials(VARS, {}, '192.168.64.10')).toEqual({
      host: '192.168.64.10',
      port: 22,
      username: 'Administrator',
      password: 'sandbox1',
    });
  });

  it('WINDOWS_PASSWORD overrides the vars-file password', () => {
    const creds = guestCredentials(VARS, { WINDOWS_PASSWORD: 'changed' }, '192.168.64.10');
    expect(creds.password).toBe('changed');
  });

  it('targets the forwarded ssh port when given (QEMU hostfwd)', () => {
    const creds = guestCredentials(VARS, {}, '127.0.0.1', 2222);
    expect(creds.host).toBe('127.0.0.1');
    expect(creds.port).toBe(2222);
  });

  it('falls back to the Administrator user when the vars file has none', () => {
    const creds = guestCredentials({ winrm_password: 'sandbox1' }, {}, '192.168.64.10');
    expect(creds.username).toBe('Administrator');
    expect(creds.password).toBe('sandbox1');
  });

  it('throws when no winrm_password is available anywhere', () => {
    expect(() => guestCredentials({}, {}, '192.168.64.10')).toThrow(/winrm_password/);
  });
});

describe('stripSentinel', () => {
  it('keeps the output before the completion sentinel', () => {
    expect(stripSentinel('bridge-status:ssh-agent=up\nade-abc123\ntrickle\n', 'ade-abc123')).toBe(
      'bridge-status:ssh-agent=up\n',
    );
  });

  it('returns the output untouched when the sentinel is missing', () => {
    expect(stripSentinel('bridge-status:docker=down\n', 'ade-abc123')).toBe(
      'bridge-status:docker=down\n',
    );
  });
});

/** A fake guest session whose exec returns the given stdout payloads one
 *  per call (the psExec wrapper strips everything after the sentinel, so
 *  the payload is just the remote command output + the sentinel). */
function fakeNodeSession(outputs: string[]): { session: SshSession; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const session = {
    exec: async (_command: string, options?: { sentinel?: string }) => {
      calls.push(_command);
      const out = outputs[index] ?? '';
      index += 1;
      return {
        code: 0,
        stdout: out ? `${out}\n${options?.sentinel ?? ''}\n` : '',
        stderr: '',
      };
    },
    sftpWrite: async () => {},
    end: () => {},
  } as unknown as SshSession;
  return { session, calls };
}

describe('findGuestNode', () => {
  it('returns the node path when the first probe finds it', async () => {
    const { session } = fakeNodeSession(['C:\\Program Files\\nodejs\\node.exe']);
    await expect(findGuestNode(session, 3, 0)).resolves.toBe('C:\\Program Files\\nodejs\\node.exe');
  });

  it('keeps probing while the guest has not applied node to the session yet', async () => {
    const { session, calls } = fakeNodeSession(['', '', 'C:\\Program Files\\nodejs\\node.exe']);
    await expect(findGuestNode(session, 3, 0)).resolves.toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(calls).toHaveLength(3);
  });

  it('returns undefined after the last probe when node never appears', async () => {
    const { session, calls } = fakeNodeSession([]);
    await expect(findGuestNode(session, 3, 0)).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
  });
});

describe('ensureGuestAgent', () => {
  it('does not upload the agent when the mkdir gate reports dir-fail (stderr CLIXML noise is not a failure)', async () => {
    let wrote = false;
    let execCalls = 0;
    const session = {
      exec: async (): Promise<{ code: number; stdout: string; stderr: string }> => {
        execCalls += 1;
        // emulate the fresh-sshd-session case: stderr carries the CLIXML
        // module-progress noise, stdout reports the dir result.
        return { code: 0, stdout: 'dir-fail\n', stderr: '#< CLIXML\n<Objs />' };
      },
      sftpWrite: async () => {
        wrote = true;
      },
      end: () => {},
    } as unknown as SshSession;
    await ensureGuestAgent(session, 'C:\\Program Files\\nodejs\\node.exe', '172.16.26.1', {
      agentPort: 4300,
      dockerPort: 4301,
    } as never);
    expect(execCalls).toBe(1);
    expect(wrote).toBe(false);
  });
});

describe('encodePsCommand', () => {
  it('encodes the script as UTF-16LE base64 (the -EncodedCommand format)', () => {
    const b64 = encodePsCommand("Write-Output 'hi'");
    expect(Buffer.from(b64, 'base64').toString('utf16le')).toBe("Write-Output 'hi'");
  });

  it('never emits a byte-order mark (always LE)', () => {
    const bytes = Buffer.from(encodePsCommand('ab'), 'base64');
    // no BOM (0xFF 0xFE) ahead of the little-endian 'a','b'.
    expect([...bytes.subarray(0, 4)]).toEqual([0x61, 0x00, 0x62, 0x00]);
  });
});
