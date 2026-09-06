// runners/windows-guest.ts — the guest side of the Windows step 3
// (VMware + QEMU backends): the credentials (from the image's vars file,
// WINDOWS_PASSWORD override, the sshd port — 22 direct, the hostfwd port
// behind QEMU), the PowerShell transport over the ssh2 session (utf16le
// base64 → -EncodedCommand, the expect guest_ps port) and the wiring of
// the bundled guest-agent-windows.js (upload over SFTP → install →
// status → docker info verification). Only the host alias differs
// (10.0.2.2 vs the NAT router x.y.z.1).
//
// Every PowerShell command is wrapped with a completion sentinel: the
// Windows OpenSSH channel does not close when the guest session's command
// finishes (the guest relays and OpenChamber hold the console handles),
// so the exec ends early when the sentinel arrives — the shell's
// `echo $sentinel` + kill-ssh-client trick, now in lib/ssh.ts.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { varsFor, resolveImage } from '../lifecycle/catalog.js';
import { sleep } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import type { SshCredentials, SshSession } from '../lib/ssh.js';
import type { VarValue } from '../lib/vars.js';
import type { RunContext, RunState } from './framework.js';
import { parseGuestStatus } from './ubuntu-guest.js';

/** The guest's agent install dir (image-fixed C:\tools), SFTP style. */
const GUEST_AGENT_DIR_WS = 'C:/tools/agent-dev-env';

/** The guest's agent install dir, PowerShell style. */
const GUEST_AGENT_DIR_PS = 'C:\\tools\\agent-dev-env';

/** The absolute guest-agent path, PowerShell style. */
const GUEST_AGENT_PS = `${GUEST_AGENT_DIR_PS}\\guest-agent-windows.js`;

/** The guest's sshd port (fixed in the image; the VMware backends reach
 *  it directly, the QEMU backend through the hostfwd forward). */
const GUEST_SSH_PORT = 22;

/** The bundled Windows guest agent (single-file, node-only). */
function guestAgentPath(): string {
  return fileURLToPath(new URL('../assets/guest/guest-agent-windows.js', import.meta.url));
}

/** @internal — resolves the guest credentials from the image's vars file
 *  (+ WINDOWS_PASSWORD override). Pure so the fallbacks are testable.
 *
 * @param vars - The vars file values.
 * @param env - Environment (WINDOWS_PASSWORD).
 * @param ip - The guest IP (the hostfwd loopback for QEMU).
 * @param sshPort - The sshd port to reach (guest 22; the forwarded host
 *   port when the guest sits behind QEMU's hostfwd).
 * @returns The credentials.
 * @throws Error when no winrm_password is available.
 */
export function guestCredentials(
  vars: Record<string, VarValue>,
  env: Record<string, string | undefined>,
  ip: string,
  sshPort = GUEST_SSH_PORT,
): SshCredentials {
  const username =
    typeof vars.winrm_username === 'string' && vars.winrm_username.trim()
      ? vars.winrm_username
      : 'Administrator';
  const password =
    env.WINDOWS_PASSWORD ?? (typeof vars.winrm_password === 'string' ? vars.winrm_password : '');
  if (!password) {
    throw new Error(
      'could not read winrm_password from the vars file — set WINDOWS_PASSWORD to the guest password.',
    );
  }
  return { host: ip, port: sshPort, username, password };
}

/** The credentials for the current run (image vars + env + guest IP).
 *
 * @param image - The image name.
 * @param env - Environment.
 * @param ip - The guest IP (the hostfwd loopback for QEMU).
 * @param sshPort - The sshd port to reach (guest 22; the forwarded host
 *   port when the guest sits behind QEMU's hostfwd).
 * @returns The credentials.
 */
export function resolveGuestCredentials(
  image: string,
  env: Record<string, string | undefined>,
  ip: string,
  sshPort = GUEST_SSH_PORT,
): SshCredentials {
  return guestCredentials(varsFor(resolveImage(image)), env, ip, sshPort);
}

/** @internal — strips the trailing output after the completion sentinel
 *  (the guest's background relays keep trickling output past it).
 *
 * @param output - The raw exec stdout.
 * @param sentinel - The sentinel the remote command echoed.
 * @returns The output up to (and excluding) the sentinel.
 */
export function stripSentinel(output: string, sentinel: string): string {
  const index = output.indexOf(sentinel);
  return index === -1 ? output : output.slice(0, index);
}

/** @internal — the -EncodedCommand payload: UTF-16LE base64 (the legacy
 *  `iconv -f UTF-8 -t UTF-16LE | base64` port; --encoded-command decodes
 *  UTF-16 regardless of BOM). Exported for the co-located test only.
 *
 * @param script - The PowerShell script (ASCII).
 * @returns The base64 string.
 */
export function encodePsCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Runs a PowerShell snippet in the guest (the expect guest_ps port:
 *  UTF-16LE base64 via -EncodedCommand, so quoting stays sane; the
 *  completion sentinel ends the exec early, because the Windows OpenSSH
 *  channel never closes on its own once the guest relays hold the console
 *  handles). The snippet MUST be ASCII-only (the packed-agents rule).
 *
 * @param session - The connected guest session.
 * @param script - The PowerShell script (ASCII).
 * @param timeoutMs - Hard budget for the whole command (5 min default,
 *   like the perl alarm in the shell).
 * @returns The script's stdout (pre-sentinel; errors land on stderr).
 */
export async function psExec(
  session: SshSession,
  script: string,
  timeoutMs = 300_000,
): Promise<{ stdout: string; stderr: string }> {
  const b64 = encodePsCommand(script);
  const sentinel = `ade-${randomBytes(8).toString('hex')}`;
  const command =
    `powershell -NoProfile -NonInteractive -EncodedCommand ${b64} ; ` + `Write-Output ${sentinel}`;
  const res = await session.exec(command, { sentinel, timeoutMs });
  return { stdout: stripSentinel(res.stdout, sentinel), stderr: res.stderr };
}

/** Default node probe attempts (the guest can still be applying the
 *  machine PATH to sshd sessions right after a reboot, so a single
 *  `where.exe node` can miss it — observed on the first boot after the
 *  auto-logon reboot). */
const NODE_PROBE_TRIES = 5;

/** Delay between node probes (same rhythm as readGuestStatus polling). */
const NODE_PROBE_DELAY_MS = 3_000;

/** Reports the path of the node binary inside the guest (the image ships
 *  node; resolve once per session like the other backends). The probe is
 *  retried a few times because a rebooting guest can serve sshd with a
 *  stale session PATH — the bridges must not be skipped on a false miss.
 *
 * @param session - The connected guest session.
 * @param tries - Probe attempts (default 5 = up to ~15 s).
 * @param delayMs - Delay between attempts (default 3 s).
 * @returns The node path, or undefined when not found.
 */
export async function findGuestNode(
  session: SshSession,
  tries = NODE_PROBE_TRIES,
  delayMs = NODE_PROBE_DELAY_MS,
): Promise<string | undefined> {
  const script = [
    '$p = where.exe node 2>$null | Select-Object -First 1',
    'if ($p) { Write-Output $p }',
  ].join('\n');
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const res = await psExec(session, script, 20_000);
    const node = res.stdout.trim().split('\n')[0] ?? '';
    if (node) {
      return node;
    }
    if (attempt < tries) {
      await sleep(delayMs);
    }
  }
  return undefined;
}

/** Uploads the bundled guest agent and runs `install` (idempotent:
 *  schtasks re-registered + the env/docker-context setup + the immediate
 *  relay start, persisted as ONLOGON tasks). The install writes
 *  start-relays.cmd into C:\tools, so the agent dir is created first.
 *
 * @param session - The connected guest session.
 * @param node - The guest's node binary.
 * @param hostAlias - The NAT host address the bridges point at.
 * @param context - The run context (ports).
 */
export async function ensureGuestAgent(
  session: SshSession,
  node: string,
  hostAlias: string,
  context: RunContext,
): Promise<void> {
  // Decide by an stdout marker, not stderr: a fresh sshd PowerShell
  // session writes CLIXML module-progress noise ("Preparing modules for
  // first use") to stderr on the first command, which used to look like
  // a failed mkdir and skipped the whole guest-agent install (observed on
  // the new windows-vmware image's first bridge setup).
  const mkdir = await psExec(
    session,
    `New-Item -ItemType Directory -Force '${GUEST_AGENT_DIR_PS}' | Out-Null; ` +
      `if (Test-Path '${GUEST_AGENT_DIR_PS}') { Write-Output 'dir-ok' } else { Write-Output 'dir-fail' }`,
    30_000,
  );
  if (!mkdir.stdout.includes('dir-ok')) {
    logger.warn('could not prepare the guest agent dir.');
    return;
  }
  try {
    await session.sftpWrite(
      `${GUEST_AGENT_DIR_WS}/guest-agent-windows.js`,
      readFileSync(guestAgentPath()),
    );
  } catch (err) {
    logger.warn(`could not upload the guest agent: ${(err as Error).message}`);
    return;
  }
  const install = await psExec(
    session,
    `& "${node}" "${GUEST_AGENT_PS}" install --agent-port ${context.agentPort} ` +
      `--docker-port ${context.dockerPort} --host-alias ${hostAlias}`,
    120_000,
  );
  if (!install.stdout.includes('installed:')) {
    logger.warn(`guest agent install failed (${install.stderr.trim() || 'no status line'}).`);
    return;
  }
  logger.ok('Guest agent installed (SSH agent + Docker bridges persistent).');
}

/** Runs `guest-agent status` and folds the bridge-status lines into the
 *  run state. The pipes need a moment after `install` starts the relays
 *  (schtasks /Run), so the status is polled a few times; the Windows
 *  OpenSSH channel never reports the remote exit code, so the outcome is
 *  purely stdout-based (the legacy's `grep bridge-status: | tail -1`).
 *
 * @param session - The connected guest session.
 * @param state - The accumulated run state.
 * @param node - The guest's node binary.
 * @param tries - Poll attempts (6 = up to ~15 s at 3 s apart).
 */
export async function readGuestStatus(
  session: SshSession,
  state: RunState,
  node: string,
  tries = 6,
): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const res = await psExec(session, `& "${node}" "${GUEST_AGENT_PS}" status`, 20_000);
    const status = parseGuestStatus(res.stdout);
    const anyKnown = status.sshAgent !== undefined || status.docker !== undefined;
    if (anyKnown) {
      if (status.sshAgent !== undefined) {
        state.bridges.agent.guestUp = status.sshAgent;
      }
      if (status.docker !== undefined) {
        state.bridges.docker.guestUp = status.docker;
      }
      // Both roles we expect are reported — no need to keep polling.
      if (status.sshAgent !== undefined && status.docker !== undefined) {
        return;
      }
    }
    if (attempt < tries - 1) {
      await sleep(3000);
    }
  }
}

/** End-to-end check: can the guest's docker CLI reach the host engine
 *  through the bridge? The probe loop runs inside one guest script (the
 *  legacy guest-setup's 20 x 1 s docker retry).
 *
 * @param session - The connected guest session.
 * @param state - The accumulated run state.
 */
export async function verifyGuestDocker(session: SshSession, state: RunState): Promise<void> {
  const script = [
    '$v = $null',
    'for ($i = 0; $i -lt 20 -and -not $v; $i++) {',
    '  Start-Sleep -Milliseconds 1000',
    "  $v = docker info --format '{{.ServerVersion}}' 2>$null",
    '}',
    'if ($v) { Write-Output "docker-ok:$v" } else { Write-Output \'docker-fail\' }',
  ].join('\n');
  const res = await psExec(session, script, 60_000);
  const match = /^docker-(ok|fail):?([^\r\n]*)$/m.exec(res.stdout.trim());
  if (match?.[1] === 'ok') {
    state.bridges.docker.serverVersion = match[2] ?? '';
    state.bridges.docker.engineUp = true;
    logger.ok(
      `Docker engine is reachable from the guest (server version ${state.bridges.docker.serverVersion}).`,
    );
    return;
  }
  logger.warn('Docker engine not reachable from the guest yet — is it running on the host?');
  logger.warn('The bridge reconnects on its own once it is; re-run to re-check.');
}
