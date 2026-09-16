// runners/windows-autologon.ts — the one-time auto-logon step of the
// two Windows boots (the legacy ensure_autologon): the image's
// autounattend.xml sets LogonCount=1 (exactly one auto-login — the OOBE
// boot), after which Windows clears AutoAdminLogon, so every later boot
// lands on the lock screen and the OpenChamber ONLOGON task never fires.
// Re-enable it once (the registry keys persist in the working VM) and
// reboot the guest so the task runs at the auto-logon. The registry
// snippets are ASCII-only (the packed-agents rule) and ride the ssh2
// PowerShell transport (windows-guest.ts). The check/enable core
// (configureAutologon) is shared by the VMware + QEMU backends — only
// the shared reboot wait's target refresh differs (the VMware NAT IP can
// change; the QEMU hostfwd target is fixed).

import { logger } from '../lib/logger.js';
import { confirmDefault } from '../lib/prompt.js';
import { openSshSession, type SshCredentials } from '../lib/ssh.js';
import type { RunContext, RunState } from './framework.js';
import { waitGuestIp } from './vmware-common.js';
import { psExec } from './windows-guest.js';
import { waitForGuestReboot } from './windows-reboot.js';

const WINLOGON_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';

/** @internal — escapes a value for a single-quoted PowerShell literal. */
function escapePs(value: string): string {
  return value.replace(/'/g, "''");
}

/** @internal — the auto-logon state check ('enabled' | 'disabled' on
 *  stdout): enabled only when AutoAdminLogon is set, targets the right
 *  user and has a password (the image's LogonCount clears the flag).
 *
 * @param username - The expected auto-logon user.
 * @returns The PowerShell script (ASCII).
 */
export function autologonCheckScript(username: string): string {
  return [
    `$w = '${WINLOGON_KEY}'`,
    '$prop = Get-ItemProperty -Path $w -ErrorAction SilentlyContinue',
    `if ($prop.AutoAdminLogon -eq '1' -and $prop.DefaultUserName -eq '${escapePs(username)}' -and $prop.DefaultPassword) {`,
    "  Write-Output 'enabled'",
    '} else {',
    "  Write-Output 'disabled'",
    '}',
  ].join('\n');
}

/** @internal — sets the auto-logon registry keys and reboots the guest.
 *
 * @param username - The user to log in as.
 * @param password - The user's password (the Winlogon DefaultPassword).
 * @returns The PowerShell script (ASCII).
 */
export function autologonEnableScript(username: string, password: string): string {
  return [
    `$w = '${WINLOGON_KEY}'`,
    'New-Item -Path $w -Force | Out-Null',
    "Set-ItemProperty -Path $w -Name AutoAdminLogon -Value '1'",
    `Set-ItemProperty -Path $w -Name DefaultUserName -Value '${escapePs(username)}'`,
    `Set-ItemProperty -Path $w -Name DefaultPassword -Value '${escapePs(password)}'`,
    'shutdown /r /t 0',
  ].join('\n');
}

/** The auto-logon check/enable core (shared by the VMware and QEMU
 *  Windows backends): probe the registry, offer the enable+reboot and
 *  apply it. Returns true when a reboot was initiated — the caller
 *  waits for sshd (the wait differs per backend: the VMware IP can
 *  change, the QEMU hostfwd target is fixed).
 *
 * @param context - The run context (yes flag).
 * @param creds - The guest credentials.
 * @returns True when the guest was told to reboot with auto-logon.
 */
export async function configureAutologon(
  context: RunContext,
  creds: SshCredentials,
): Promise<boolean> {
  const session = await openSshSession(creds);
  try {
    const check = await psExec(session, autologonCheckScript(creds.username), 60_000);
    if (/enabled/.test(check.stdout)) {
      logger.ok('Guest auto-logon is enabled — OpenChamber starts at logon.');
      return false;
    }
    logger.info('Guest auto-logon is disabled (the image allows one OOBE logon only).');
    if (
      !(await confirmDefault(
        'Enable auto-logon and reboot the guest so OpenChamber starts at boot?',
        { default: 'y', yes: context.options.yes },
      ))
    ) {
      logger.info('OpenChamber will not start until someone logs in via RDP or the console.');
      return false;
    }
    await psExec(session, autologonEnableScript(creds.username, creds.password), 60_000);
    return true;
  } catch (err) {
    logger.warn(`auto-logon setup failed: ${(err as Error).message}`);
    return false;
  } finally {
    session.end();
  }
}

/** The VMware auto-logon flow: configure, then wait for the rebooted
 *  guest via the shared down-then-up wait (the auto-logon makes the
 *  OpenChamber ONLOGON task fire at boot). The reboot can land on a new
 *  NAT address, so the target is refreshed through waitGuestIp — after
 *  the guest is actually down (vmrun keeps reporting the old IP until
 *  then).
 *
 * @param context - The run context (yes flag).
 * @param state - The accumulated run state (vmIp refreshed after reboot).
 * @param workVmx - The working VM vmx.
 * @param creds - The guest credentials.
 */
export async function ensureAutologon(
  context: RunContext,
  state: RunState,
  workVmx: string,
  creds: SshCredentials,
): Promise<void> {
  if (!(await configureAutologon(context, creds))) {
    return;
  }
  logger.info('Rebooting the guest (a minute or two)...');
  const rebooted = await waitForGuestReboot(
    creds,
    async () => {
      const ip = await waitGuestIp(workVmx);
      return { ...creds, host: ip };
    },
    'Guest rebooted with auto-logon enabled.',
  );
  state.vmIp = rebooted.host;
}
