// settings/ubuntu-copy.ts — the IO half of the Ubuntu user-settings
// copy: stage the host settings into the guest's layout, tar them
// locally (--no-xattrs, AppleDouble stripped), move the archive over
// SFTP and unpack with ssh exec (the legacy scp + settings_ssh flow, now
// ssh2). The marker-gated `ensure` flow and the on-demand `sync` flow
// mirror settings/macos-copy.ts — only the transport differs, plus the
// OPENCODE_MODELS_URL write (the OpenChamber systemd user drop-in and
// the login-shell env file, built by openCodeModelsUrlScript).
//
// The guest-side unpack needs the user's password for `sudo -S` (the
// image up to this release shipped root-owned ~/.local); callers hold
// the credentials and pass the password through.

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
import { sanitizeGitconfig } from './common.js';
import {
  collectSettingsFiles,
  guestSettingsCheckScript,
  guestSettingsMarkerScript,
  guestUnpackScript,
  GUEST_HOME,
  mapGuestPath,
  openCodeModelsUrlScript,
  openchamberRestartCommand,
  SETTINGS_VERSION,
  type SettingsState,
} from './ubuntu.js';

/** True when the guest already has settings of the current version
 *  (numeric marker compare, like the shell's `-ge`).
 *
 * @param session - The connected guest session.
 * @returns True when the marker is current.
 */
async function guestSettingsUpToDate(session: SshSession): Promise<boolean> {
  const res = await session.exec(`sh -s ${SETTINGS_VERSION}`, {
    input: guestSettingsCheckScript(),
  });
  return res.code === 0;
}

/** @internal — copies one host file into the staged guest tree.
 *
 * @param home - The host home directory.
 * @param tree - The staging tree root.
 * @param file - The path relative to home (host layout).
 * @returns True when staged.
 */
function stageFile(home: string, tree: string, file: string): boolean {
  const target = join(tree, mapGuestPath(file));
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
 *  guest home, mode preserved); falls back to shipping it as-is.
 *
 * @param home - The host home directory.
 * @param tree - The staging tree root.
 * @returns True when staged.
 */
function stageGitconfig(home: string, tree: string): boolean {
  const source = join(home, '.gitconfig');
  const target = join(tree, '.gitconfig');
  try {
    const sanitized = sanitizeGitconfig(readFileSync(source, 'utf8'), home, GUEST_HOME);
    const { mode } = statSync(source);
    writeFileSync(target, sanitized, { mode: mode & 0o777 });
    return true;
  } catch {
    logger.warn('could not sanitize .gitconfig — shipping it as-is.');
    return stageFile(home, tree, '.gitconfig');
  }
}

/** @internal — removes AppleDouble companions and .DS_Store from the
 *  staged tree (legacy junk Linux does not need; packed, they made some
 *  guests' tar abort). */
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
 *  resolve to "not found". Writes the systemd user drop-in for the
 *  OpenChamber service plus the login-shell env file, then reloads the
 *  user manager (the caller's OpenChamber restart picks the variable up).
 *  Non-fatal: a failure only degrades the registry, not the copied
 *  settings.
 *
 * @param session - The connected guest session.
 * @returns True when the variable was written.
 */
async function applyModelsUrlEnv(session: SshSession): Promise<boolean> {
  const modelsUrl = process.env.OPENCODE_MODELS_URL ?? '';
  if (!modelsUrl) {
    return false;
  }
  if (/[\r\n']/.test(modelsUrl)) {
    logger.warn('OPENCODE_MODELS_URL contains a quote or newline — not setting it in the guest.');
    return false;
  }
  const env = await session.exec(openCodeModelsUrlScript(modelsUrl));
  if (env.code !== 0 || !env.stdout.includes('env-ok')) {
    logger.warn(
      'could not set OPENCODE_MODELS_URL in the guest — opencode keeps the public model registry.',
    );
    return false;
  }
  logger.ok('Set OPENCODE_MODELS_URL for OpenChamber and the login shells.');
  return true;
}

/** Copies the settings into the guest: staged tree → tar.gz → sftp →
 *  unpack + cleanup, then the version marker (the legacy dance, with the
 *  password piped into sudo -S for the root-owned ~/.local fix).
 *
 * @param session - The connected guest session.
 * @param files - The settings paths (relative to the host home).
 * @param home - The host home directory.
 * @param password - The guest user's password (sudo -S).
 * @throws Error when the pack, upload, unpack or marker write fails.
 */
async function copySettingsToGuest(
  session: SshSession,
  files: string[],
  home: string,
  password: string,
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
    if (files.includes('.gitconfig') && stageGitconfig(home, tree)) {
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

    await session.sftpWrite('/tmp/agent-dev-env-settings.tar.gz', readFileSync(archive));
    const unpack = await session.exec(guestUnpackScript(password));
    if (unpack.code !== 0) {
      throw new Error(`could not unpack the settings in the guest:\n${unpack.stderr.trim()}`);
    }

    const marker = await session.exec(`sh -s ${SETTINGS_VERSION}`, {
      input: guestSettingsMarkerScript(),
    });
    if (marker.code !== 0) {
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
 *  systemd user service; non-fatal — warns on failure like the shell).
 *
 * @param session - The connected guest session.
 * @returns True when restarted.
 */
export async function restartOpenchamber(session: SshSession): Promise<boolean> {
  const res = await session.exec(openchamberRestartCommand());
  if (res.code !== 0) {
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
  logger.info("Found on the host — will copy into the guest's home directory:");
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
 * @param password - The guest user's password (sudo -S).
 * @returns The step outcome (see SettingsState).
 */
export async function ensureUserSettings(
  session: SshSession,
  home: string = homedir(),
  yes = false,
  password = '',
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
  await copySettingsToGuest(session, files, home, password);
  logger.ok(`Copied ${files.length} item(s) into the guest.`);
  return 'copied';
}

/** The `sync` flow: always copies (no marker gate) + restarts OpenChamber.
 *
 * @param session - The connected guest session.
 * @param home - The host home directory.
 * @param yes - Skip confirmations.
 * @param password - The guest user's password (sudo -S).
 * @returns The outcome (copied | none | declined | failed).
 */
export async function syncUserSettings(
  session: SshSession,
  home: string = homedir(),
  yes = false,
  password = '',
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
  await copySettingsToGuest(session, files, home, password);
  logger.ok(`Copied ${files.length} item(s) into the guest (version ${SETTINGS_VERSION}).`);
  await restartOpenchamber(session);
  return 'copied';
}
