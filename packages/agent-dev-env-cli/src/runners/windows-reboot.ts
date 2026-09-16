// runners/windows-reboot.ts — the post-settings reboot offer shared by
// the two Windows backends (`run` + `sync`) and the shared guest-reboot
// wait the auto-logon steps use too: Windows applies a user-scope
// environment variable only to the processes it starts after it was
// written (`OPENCODE_MODELS_URL`), so once one was added the user is
// offered a guest reboot before relying on it. The reboot request rides
// the same psExec channel as the other guest commands; the wait is a
// down-then-up observation — the guest must stop answering on the old
// target first, because the pre-shutdown sshd otherwise makes the
// "rebooted" wait return while the guest is still up and the next step
// lands in the shutdown window (its ssh session dies with ssh2's
// "Not connected"). The VMware NAT IP can change across the reboot and
// the QEMU hostfwd target cannot, so the callers pass the target
// refresh in.

import { sleep } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { confirmDefault } from '../lib/prompt.js';
import {
  probeSshd,
  waitForSshd,
  type SshCredentials,
  type SshProbeOutcome,
  type SshSession,
} from '../lib/ssh.js';
import { psExec } from './windows-guest.js';

/** @internal — the guest-side reboot (ASCII PowerShell): requests an
 *  immediate restart and prints `reboot-ok`; the channel can drop before
 *  the marker arrives, so the request itself is what matters. Exported
 *  for the co-located tests.
 *
 * @returns The script text (ASCII).
 */
export function guestRebootScript(): string {
  return ['shutdown /r /t 0', "Write-Output 'reboot-ok'", ''].join('\n');
}

/** @internal — sends the reboot request (best-effort — the guest may cut
 *  the SSH connection before the command reports back; the psExec watchdog
 *  bounds the wait). Exported for the co-located tests.
 *
 * @param session - The connected guest session.
 */
export async function requestGuestReboot(session: SshSession): Promise<void> {
  logger.info('Rebooting the guest (a minute or two)...');
  await psExec(session, guestRebootScript(), 60_000);
}

/** The shutdown-observation patience: 150 x 2 s probes. The guest usually
 *  stops answering within seconds of the request; the window covers a
 *  slow Windows shutdown. */
const SHUTDOWN_PROBE_TRIES = 150;
const SHUTDOWN_PROBE_DELAY_MS = 2_000;
/** The per-probe handshake budget — short, because a powered-off guest
 *  behind a bound QEMU hostfwd listener shows up as a handshake timeout,
 *  not a refusal. */
const SHUTDOWN_PROBE_READY_TIMEOUT_MS = 5_000;
/** Consecutive non-`up` probes that count as "the guest went down" (one
 *  handshake hiccup on a healthy guest must not). */
const SHUTDOWN_MISSES = 2;

/** The probe surface of waitForGuestShutdown (probeSshd-shaped, injectable
 *  so the co-located test needs no guest). */
type GuestSshProbe = (
  credentials: SshCredentials,
  readyTimeoutMs?: number,
) => Promise<SshProbeOutcome>;

/** @internal — waits for the guest to stop answering sshd after a reboot
 *  request — the pre-shutdown sshd answers instantly otherwise and the
 *  reboot wait returns before the guest has even gone down. Exported for
 *  the co-located tests (production reaches it through
 *  waitForGuestReboot).
 *
 * @param credentials - The guest to probe (the pre-reboot target).
 * @param probe - The probe implementation (defaults to probeSshd).
 * @param options - Poll count/delay + per-attempt budget overrides.
 * @returns True once the guest stopped answering, false when it never did.
 */
export async function waitForGuestShutdown(
  credentials: SshCredentials,
  probe: GuestSshProbe = probeSshd,
  options: { tries?: number; delayMs?: number; readyTimeoutMs?: number } = {},
): Promise<boolean> {
  const tries = options.tries ?? SHUTDOWN_PROBE_TRIES;
  const delayMs = options.delayMs ?? SHUTDOWN_PROBE_DELAY_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? SHUTDOWN_PROBE_READY_TIMEOUT_MS;
  let misses = 0;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if ((await probe(credentials, readyTimeoutMs)) === 'up') {
      misses = 0;
    } else {
      misses += 1;
      if (misses >= SHUTDOWN_MISSES) {
        return true;
      }
    }
    if (attempt < tries - 1) {
      await sleep(delayMs);
    }
  }
  return false;
}

/** Waits for a requested guest reboot: down first, then up. The guest must
 *  stop answering on `credentials` before the refreshed target is polled,
 *  so the wait can never mistake the still-running pre-reboot guest for
 *  the rebooted one. The refresh runs after the shutdown (VMware
 *  re-discovers the NAT IP — `vmrun getGuestIPAddress` keeps reporting the
 *  old address until the guest is actually down; QEMU returns the fixed
 *  hostfwd credentials).
 *
 * @param credentials - The guest credentials before the reboot.
 * @param refresh - Resolves the target to poll once the guest is down.
 * @param readyMessage - The success line once the guest answers again.
 * @returns The post-reboot credentials.
 */
export async function waitForGuestReboot(
  credentials: SshCredentials,
  refresh: () => Promise<SshCredentials>,
  readyMessage: string,
): Promise<SshCredentials> {
  process.stdout.write('    Waiting for the guest to shut down (up to 5 min)');
  if (!(await waitForGuestShutdown(credentials))) {
    process.stdout.write(` ${logger.color('yellow')}failed${logger.reset()}\n`);
    return logger.die('the guest never stopped answering — did the reboot request reach it?');
  }
  process.stdout.write(` ${logger.color('green')}done${logger.reset()}\n`);

  const rebooted = await refresh();
  process.stdout.write('    Waiting for the guest to reboot (up to 10 min)');
  if (await waitForSshd(rebooted)) {
    process.stdout.write(` ${logger.color('green')}done${logger.reset()}\n`);
    logger.ok(readyMessage);
    return rebooted;
  }
  process.stdout.write(` ${logger.color('yellow')}failed${logger.reset()}\n`);
  return logger.die(
    `timed out waiting for the guest to reboot (no SSH on ${rebooted.host}:${rebooted.port}).`,
  );
}

/** Offers the reboot a settings copy needs after it wrote a user-scope
 *  environment variable: without it the already-running OpenChamber and
 *  opencode processes keep the old environment. `yes` accepts the offer's
 *  default (reboot) without a prompt.
 *
 * @param session - The connected guest session.
 * @param yes - Skip the prompt and take the default answer (--yes).
 * @param credentials - The guest credentials before the reboot (the
 *   shutdown observation probes them).
 * @param refresh - Resolves the credentials to wait on after the reboot.
 * @returns The refreshed credentials when the guest rebooted, undefined
 *   when the user declined.
 */
export async function offerGuestReboot(
  session: SshSession,
  yes: boolean,
  credentials: SshCredentials,
  refresh: () => Promise<SshCredentials>,
): Promise<SshCredentials | undefined> {
  logger.info('Windows applies the new environment variable only to processes started afterwards.');
  if (
    !(await confirmDefault('Reboot the guest now so it picks up the new environment variable?', {
      default: 'y',
      yes,
    }))
  ) {
    logger.warn('Skipped — reboot the guest before relying on the new environment variable.');
    return undefined;
  }
  await requestGuestReboot(session);
  return waitForGuestReboot(
    credentials,
    refresh,
    'Guest rebooted so the new environment variable applies.',
  );
}
