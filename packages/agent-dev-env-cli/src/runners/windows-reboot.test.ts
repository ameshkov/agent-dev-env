import { describe, expect, it } from 'vitest';
import type { SshCredentials, SshProbeOutcome, SshSession } from '../lib/ssh.js';
import { encodePsCommand } from './windows-guest.js';
import { guestRebootScript, requestGuestReboot, waitForGuestShutdown } from './windows-reboot.js';

/** A fake guest session recording the commands it was sent (the psExec
 *  transport ends each exec on the echoed sentinel). */
function fakeSession(): { session: SshSession; calls: string[] } {
  const calls: string[] = [];
  const session = {
    exec: async (command: string, options?: { sentinel?: string }) => {
      calls.push(command);
      return { code: 0, stdout: `${options?.sentinel ?? ''}\n`, stderr: '' };
    },
    sftpWrite: async () => {},
    end: () => {},
  } as unknown as SshSession;
  return { session, calls };
}

describe('guestRebootScript', () => {
  it('requests an immediate restart and reports the request', () => {
    const script = guestRebootScript();
    expect(script).toContain('shutdown /r /t 0');
    expect(script).toContain("Write-Output 'reboot-ok'");
  });

  it('keeps the script ASCII-only (the PowerShell transport rule)', () => {
    for (const char of guestRebootScript()) {
      expect(char.charCodeAt(0)).toBeLessThan(128);
    }
  });
});

describe('requestGuestReboot', () => {
  it('sends the reboot script as an encoded PowerShell command', async () => {
    const { session, calls } = fakeSession();
    await requestGuestReboot(session);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(encodePsCommand(guestRebootScript()));
  });
});

const CREDS: SshCredentials = {
  host: '192.168.64.10',
  port: 22,
  username: 'Administrator',
  password: 'sandbox1',
};

/** A scripted probe: each call consumes the next outcome (the last one
 *  repeats) and records the target + handshake budget it was given. */
function scriptedProbe(outcomes: SshProbeOutcome[]): {
  probe: (creds: SshCredentials, readyTimeoutMs?: number) => Promise<SshProbeOutcome>;
  calls: Array<{ host: string; readyTimeoutMs?: number }>;
} {
  const calls: Array<{ host: string; readyTimeoutMs?: number }> = [];
  let index = 0;
  return {
    calls,
    probe: async (creds: SshCredentials, readyTimeoutMs?: number) => {
      calls.push({ host: creds.host, readyTimeoutMs });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return outcome;
    },
  };
}

describe('waitForGuestShutdown', () => {
  it('returns true once two consecutive probes stop answering sshd', async () => {
    const { probe, calls } = scriptedProbe(['up', 'up', 'down', 'down']);
    const down = await waitForGuestShutdown(CREDS, probe, { tries: 10, delayMs: 0 });
    expect(down).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({ host: '192.168.64.10', readyTimeoutMs: 5000 });
  });

  it('does not treat a single miss on a healthy guest as the shutdown', async () => {
    const { probe, calls } = scriptedProbe(['up', 'down', 'up', 'down', 'down']);
    const down = await waitForGuestShutdown(CREDS, probe, { tries: 10, delayMs: 0 });
    expect(down).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it('counts a handshake timeout as the guest going down (the QEMU hostfwd case)', async () => {
    const { probe, calls } = scriptedProbe(['up', 'unknown', 'unknown']);
    const down = await waitForGuestShutdown(CREDS, probe, { tries: 10, delayMs: 0 });
    expect(down).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('gives up when the guest never stops answering', async () => {
    const { probe, calls } = scriptedProbe(['up']);
    const down = await waitForGuestShutdown(CREDS, probe, { tries: 5, delayMs: 0 });
    expect(down).toBe(false);
    expect(calls).toHaveLength(5);
  });
});
