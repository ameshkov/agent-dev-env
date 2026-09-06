// settings/windows-copy.ts — the IO half of the Windows user-settings
// copy: stage the host settings into the guest's layout (macOS host paths
// mapped to the Windows profile), pack them into a tar.gz locally, move
// the archive over SFTP and apply it inside the guest with a PowerShell
// snippet (the in-box bsdtar extracts into %USERPROFILE% — the transport
// is psExec + SFTP over ssh2, the Windows backends' guest channel, which
// never reports remote exit codes, so every step ends on an stdout
// marker). The marker-gated `ensure` flow and the on-demand `sync` flow
// mirror settings/ubuntu-copy.ts — only the transport differs.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '../lib/exec.js';
import { logger } from '../lib/logger.js';
import { confirm } from '../lib/prompt.js';
import type { SshSession } from '../lib/ssh.js';
import { psExec } from '../runners/windows-guest.js';
import { collectSettingsFiles, sanitizeGitconfig } from './common.js';
import {
  guestApplyScript,
  guestHome,
  guestSettingsCheckScript,
  guestSettingsMarkerScript,
  mapGuestPath,
  openCodeModelsUrlScript,
  openchamberRestartCommand,
  SETTINGS_VERSION,
  type SettingsState,
} from './windows.js';

/** The archive's guest path (SFTP style, forward slashes — the same
 *  location the apply script extracts from, `%TEMP%` of the user).
 *
 * @param username - The guest user.
 * @returns The absolute archive path in the guest.
 */
function archiveRemotePath(username: string): string {
  return `${guestHome(username)}/AppData/Local/Temp/agent-dev-env-settings.tar.gz`;
}

/** True when the guest already has settings of the current version (the
 *  versioned marker the copy writes; stdout marker compare — the Windows
 *  OpenSSH channel has no reliable remote exit code).
 *
 * @param session - The connected guest session.
 * @returns True when the marker is current.
 */
async function guestSettingsUpToDate(session: SshSession): Promise<boolean> {
  const res = await psExec(session, guestSettingsCheckScript(), 20_000);
  return res.stdout.includes('marker-current');
}

/** @internal — copies one host file into the staged guest tree. Exported
 *  for the co-located tests.
 *
 * @param home - The host home directory.
 * @param tree - The staging tree root.
 * @param file - The path relative to home (host layout).
 * @returns True when staged.
 */
export function stageFile(home: string, tree: string, file: string): boolean {
  const target = join(tree, ...mapGuestPath(file).split('/'));
  try {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(home, file), target, { recursive: true, preserveTimestamps: true });
    return true;
  } catch {
    logger.warn(`could not stage ${file} — continuing.`);
    return false;
  }
}

/** @internal — sanitizes the host .gitconfig into the tree (host home →
 *  the Windows guest home, forward slashes so gitconfig values stay valid);
 *  falls back to shipping it as-is. Exported for the co-located tests.
 *
 * @param home - The host home directory.
 * @param tree - The staging tree root.
 * @param username - The guest user.
 * @returns True when staged.
 */
export function stageGitconfig(home: string, tree: string, username: string): boolean {
  const source = join(home, '.gitconfig');
  const target = join(tree, '.gitconfig');
  try {
    const sanitized = sanitizeGitconfig(readFileSync(source, 'utf8'), home, guestHome(username));
    const { mode } = statSync(source);
    writeFileSync(target, sanitized, { mode: mode & 0o777 });
    return true;
  } catch {
    logger.warn('could not sanitize .gitconfig — shipping it as-is.');
    return stageFile(home, tree, '.gitconfig');
  }
}

/** @internal — removes AppleDouble companions and .DS_Store from the
 *  staged tree (macOS junk the guest does not need). */
function stripAppleDouble(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      stripAppleDouble(full);
      continue;
    }
    if (entry.name.startsWith('._') || entry.name === '.DS_Store') {
      rmSync(full, { force: true });
    }
  }
}

/** Sets OPENCODE_MODELS_URL in the guest when the host uses a custom
 *  opencode model registry — without it the guest loads the public
 *  models.dev registry and private provider models (e.g. tokenguard)
 *  resolve to "not found". Non-fatal: a failure only degrades the
 *  registry, not the copied settings.
 *
 * @param session - The connected guest session.
 */
async function applyModelsUrlEnv(session: SshSession): Promise<void> {
  const modelsUrl = process.env.OPENCODE_MODELS_URL ?? '';
  if (!modelsUrl) {
    return;
  }
  const env = await psExec(session, openCodeModelsUrlScript(modelsUrl), 30_000);
  if (!env.stdout.includes('env-ok')) {
    logger.warn(
      'could not set OPENCODE_MODELS_URL in the guest — opencode keeps the public model registry.',
    );
  }
}

/** Copies the settings into the guest: staged tree → tar.gz → SFTP →
 *  psExec apply + cleanup, then the version marker. Every step reports
 *  through an stdout marker (no remote exit codes on Windows OpenSSH).
 *
 * @param session - The connected guest session.
 * @param files - The settings paths (relative to the host home).
 * @param home - The host home directory.
 * @param username - The guest user.
 * @throws Error when the pack, upload, apply or marker write fails.
 */
async function copySettingsToGuest(
  session: SshSession,
  files: string[],
  home: string,
  username: string,
): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), 'agent-dev-env-settings.'));
  try {
    const tree = join(staging, 'tree');
    mkdirSync(tree, { recursive: true });
    let copied = 0;
    for (const file of files) {
      if (file === '.gitconfig') {
        continue;
      }
      if (stageFile(home, tree, file)) {
        copied += 1;
      }
    }
    if (files.includes('.gitconfig') && stageGitconfig(home, tree, username)) {
      copied += 1;
    }
    if (copied === 0) {
      throw new Error('nothing was staged — no settings to copy.');
    }

    stripAppleDouble(tree);
    const archive = join(staging, 'settings.tar.gz');
    const pack = await run('tar', ['--no-xattrs', '-czf', archive, '-C', tree, '.']);
    if (pack.code !== 0) {
      throw new Error('could not pack the staged settings.');
    }

    await session.sftpWrite(archiveRemotePath(username), readFileSync(archive));
    const apply = await psExec(session, guestApplyScript(username), 120_000);
    if (!apply.stdout.includes('settings-ok')) {
      throw new Error(`could not unpack the settings in the guest:\n${apply.stderr.trim()}`);
    }

    const marker = await psExec(session, guestSettingsMarkerScript(), 30_000);
    if (!marker.stdout.includes('marker-ok')) {
      throw new Error(
        'settings were copied, but the version marker could not be written — ' +
          'they will be offered again on the next run.',
      );
    }
    await applyModelsUrlEnv(session);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Restarts OpenChamber so a fresh settings copy takes effect (the
 *  `dev.openchamber.web` scheduled task; non-fatal — warns on failure like
 *  the other backends).
 *
 * @param session - The connected guest session.
 * @returns True when restarted.
 */
export async function restartOpenchamber(session: SshSession): Promise<boolean> {
  const res = await psExec(session, openchamberRestartCommand(), 60_000);
  if (!res.stdout.includes('restart-ok')) {
    logger.warn(
      'could not restart OpenChamber — it will pick up the new settings on its next start.',
    );
    return false;
  }
  logger.ok('Restarted OpenChamber so it picks up the new user settings.');
  return true;
}

/** Prints the file list and asks the standard confirmation.
 *
 * @param home - The host home directory (display paths).
 * @param files - The settings paths.
 * @param yes - Skip the confirmation.
 * @returns True when the user confirmed.
 */
async function confirmSettingsCopy(home: string, files: string[], yes: boolean): Promise<boolean> {
  logger.info("Found on the host — will copy into the guest's profile directory:");
  for (const file of files) {
    logger.info(`  ${join(home, file)}`);
  }
  if (yes) {
    return true;
  }
  return confirm('Copy these user settings into the guest?', { default: 'y' });
}

/** The run step: marker-gated copy (offered once per settings version).
 *
 * @param session - The connected guest session.
 * @param home - The host home directory.
 * @param yes - Skip confirmations.
 * @param username - The guest user (defaults to the image account).
 * @returns The step outcome (see SettingsState).
 */
export async function ensureUserSettings(
  session: SshSession,
  home: string = homedir(),
  yes = false,
  username = 'Administrator',
): Promise<SettingsState> {
  if (await guestSettingsUpToDate(session)) {
    logger.ok(`User settings are already in the guest (version ${SETTINGS_VERSION}) — skipping.`);
    return 'uptodate';
  }
  const files = collectSettingsFiles(home);
  if (files.length === 0) {
    logger.info(
      'No user settings found on the host (opencode config and auth, ' +
        'OpenCodeReview config, Copilot config, VS Code config and extensions, ' +
        '~/.ssh, ~/.gitconfig) — nothing to copy.',
    );
    return 'none';
  }
  if (!(await confirmSettingsCopy(home, files, yes))) {
    logger.info('Skipped — re-run `agent-dev-env run` to copy them later.');
    return 'declined';
  }
  await copySettingsToGuest(session, files, home, username);
  logger.ok(`Copied ${files.length} item(s) into the guest.`);
  return 'copied';
}

/** The `sync` flow: always copies (no marker gate) + restarts OpenChamber.
 *
 * @param session - The connected guest session.
 * @param home - The host home directory.
 * @param yes - Skip confirmations.
 * @param username - The guest user (defaults to the image account).
 * @returns The outcome (copied | none | declined | failed).
 */
export async function syncUserSettings(
  session: SshSession,
  home: string = homedir(),
  yes = false,
  username = 'Administrator',
): Promise<SettingsState> {
  const files = collectSettingsFiles(home);
  if (files.length === 0) {
    logger.info(
      'No user settings found on the host (opencode config and auth, ' +
        'OpenCodeReview config, Copilot config, VS Code config and extensions, ' +
        '~/.ssh, ~/.gitconfig) — nothing to copy.',
    );
    return 'none';
  }
  if (!(await confirmSettingsCopy(home, files, yes))) {
    logger.info('Skipped — re-run `agent-dev-env sync` to copy them later.');
    return 'declined';
  }
  await copySettingsToGuest(session, files, home, username);
  logger.ok(`Copied ${files.length} item(s) into the guest (version ${SETTINGS_VERSION}).`);
  await restartOpenchamber(session);
  return 'copied';
}
