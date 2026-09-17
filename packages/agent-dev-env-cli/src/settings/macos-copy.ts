// settings/macos-copy.ts — the IO half of the macOS user-settings copy:
// tar streams over `tart exec -i` (binary-safe pipe — tar may contain
// arbitrary content, so the text-oriented run() helpers cannot carry
// it), the marker check/write, the OpenChamber restart, and the two
// flows: `ensure` (run step, marker-gated) and `sync` (on demand), plus
// the OPENCODE_MODELS_URL write (the green-field env file sourced from
// ~/.zprofile/~/.zshrc, built by openCodeModelsUrlScript).

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execVm } from '../lib/tart.js';
import { logger } from '../lib/logger.js';
import { confirm } from '../lib/prompt.js';
import {
  collectSettingsFiles,
  guestSettingsCheckScript,
  guestSettingsMarkerScript,
  guestUnpackCommand,
  GUEST_HOME,
  openCodeModelsUrlScript,
  openchamberRestartScript,
  sanitizeGitconfig,
  SETTINGS_VERSION,
  type SettingsState,
} from './macos.js';

/** Streams a tar archive (built from `includes` under `cwd`) into the
 *  guest and unpacks it there. Binary-safe: the producer's stdout pipes
 *  straight into `tart exec`'s stdin.
 *
 * @param vm - The running VM name.
 * @param cwd - The directory to archive from.
 * @param includes - The paths (relative to cwd) to include.
 * @param unpackCommand - The guest-side unpack command.
 * @returns Resolves on success; rejects with the guest's stderr on fail.
 */
function streamTarIntoGuest(
  vm: string,
  cwd: string,
  includes: string[],
  unpackCommand: string,
): Promise<void> {
  const tar = spawn('tar', ['-C', cwd, '-cf', '-', ...includes]);
  const guest = spawn('tart', ['exec', '-i', vm, 'sh', '-c', unpackCommand]);
  return new Promise((resolve, reject) => {
    const codes: Record<string, number | null> = { tar: null, guest: null };
    let guestError = '';
    let settled = false;
    guest.stderr.setEncoding('utf8');
    guest.stderr.on('data', (chunk: string) => {
      guestError += chunk;
    });
    const finish = (): void => {
      if (settled || codes.tar === null || codes.guest === null) {
        return;
      }
      settled = true;
      if (codes.tar === 0 && codes.guest === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `settings copy failed (tar ${codes.tar}, tart exec ${codes.guest})` +
              (guestError ? `\n${guestError.trim()}` : ''),
          ),
        );
      }
    };
    registerExit(tar, 'tar', codes, finish);
    registerExit(guest, 'guest', codes, finish);
    tar.stdout.pipe(guest.stdin);
  });
}

/** @internal — tracks one side's exit code and re-checks the pair. */
function registerExit(
  proc: ReturnType<typeof spawn>,
  name: 'tar' | 'guest',
  codes: Record<string, number | null>,
  finish: () => void,
): void {
  const setCode = (code: number | null): void => {
    codes[name] = code;
    finish();
  };
  proc.on('close', (code) => setCode(code ?? -1));
  proc.on('error', () => setCode(-1));
}

/** @internal — true when the guest already has settings of the current
 *  version (numeric marker compare, like the shell's `-ge`). */
export async function guestSettingsUpToDate(vm: string): Promise<boolean> {
  const res = await execVm(vm, ['sh', '-s', String(SETTINGS_VERSION)], {
    input: guestSettingsCheckScript(),
  });
  return res.code === 0;
}

/** Sets OPENCODE_MODELS_URL in the guest when the host uses a custom
 *  opencode model registry — without it the guest loads the public
 *  models.dev registry and private provider models (e.g. tokenguard)
 *  resolve to "not found". Writes the green-field env file and sources it
 *  from ~/.zprofile/~/.zshrc; the caller's OpenChamber restart sources
 *  ~/.zprofile before re-creating the LaunchAgent, so the export lands in
 *  the service environment. Non-fatal: a failure only degrades the
 *  registry, not the copied settings.
 *
 * @param vm - The running VM name.
 * @returns True when the variable was written.
 */
async function applyModelsUrlEnv(vm: string): Promise<boolean> {
  const modelsUrl = process.env.OPENCODE_MODELS_URL ?? '';
  if (!modelsUrl) {
    return false;
  }
  if (/[\r\n']/.test(modelsUrl)) {
    logger.warn('OPENCODE_MODELS_URL contains a quote or newline — not setting it in the guest.');
    return false;
  }
  const res = await execVm(vm, ['sh', '-s'], { input: openCodeModelsUrlScript(modelsUrl) });
  if (res.code !== 0 || !res.stdout.includes('env-ok')) {
    logger.warn(
      'could not set OPENCODE_MODELS_URL in the guest — opencode keeps the public model registry.',
    );
    return false;
  }
  logger.ok('Set OPENCODE_MODELS_URL for OpenChamber and the login shells.');
  return true;
}

/** Copies the settings into the guest: archive 1 = everything except
 *  .gitconfig, archive 2 = the sanitized .gitconfig, then the version
 *  marker (the legacy two-archive dance — bsdtar stops at the first
 *  end-of-archive marker).
 *
 * @param vm - The running VM name.
 * @param files - The settings paths (relative to the host home).
 * @param home - The host home directory.
 * @throws Error when the copy or the marker write fails.
 */
async function copySettingsToGuest(vm: string, files: string[], home: string): Promise<void> {
  const staging = mkdtempSync(join(tmpdir(), 'agent-dev-env-settings.'));
  try {
    const gitconfig = files.includes('.gitconfig');
    const hasGitconfig = gitconfig && stageSanitizedGitconfig(home, staging);
    const rest = files.filter((file) => file !== '.gitconfig');
    if (rest.length > 0) {
      await streamTarIntoGuest(vm, home, rest, guestUnpackCommand());
    }
    if (hasGitconfig) {
      await streamTarIntoGuest(vm, staging, ['.gitconfig'], 'tar -C "$HOME" -xf -');
    }

    const marker = await execVm(vm, ['sh', '-s', String(SETTINGS_VERSION)], {
      input: guestSettingsMarkerScript(),
    });
    if (marker.code !== 0) {
      throw new Error(
        'settings were copied, but the version marker could not be written — ' +
          'they will be offered again on the next run.',
      );
    }
    await applyModelsUrlEnv(vm);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** @internal — sanitized .gitconfig in the staging dir; false when the
 *  host has no .gitconfig (or it could not be staged — the sanitized
 *  copy is preferred, the raw file is shipped as-is as a fallback, like
 *  the Ubuntu flow). Exported for the co-located tests.
 *
 * @param home - The host home directory.
 * @param staging - The staging dir to write into.
 * @returns True when a .gitconfig was staged.
 */
export function stageSanitizedGitconfig(home: string, staging: string): boolean {
  const source = join(home, '.gitconfig');
  try {
    const content = readFileSync(source, 'utf8');
    const sanitized = sanitizeGitconfig(content, home, GUEST_HOME);
    writeFileSync(join(staging, '.gitconfig'), sanitized);
    // Preserve the source's permissions (git may exec helper scripts).
    try {
      const { mode } = statSync(source);
      writeFileSync(join(staging, '.gitconfig'), sanitized, { mode: mode & 0o777 });
    } catch {
      // best-effort mode preserve
    }
    return true;
  } catch {
    logger.warn('could not sanitize .gitconfig — shipping it as-is.');
    try {
      cpSync(source, join(staging, '.gitconfig'), { preserveTimestamps: true });
      return true;
    } catch {
      logger.warn('could not stage .gitconfig — skipping it.');
      return false;
    }
  }
}

/** Restarts OpenChamber so a fresh settings copy takes effect: the
 *  LaunchAgent is re-created (`startup disable` + `startup enable`) after
 *  sourcing ~/.zprofile, so both the copied settings and the user's
 *  zprofile exports (OPENCHAMBER_DATA_DIR, OPENCODE_DATA_DIR, ...) land
 *  in the service's environment snapshot — `openchamber restart` alone
 *  would keep the old launchd environment. Returns true when the restart
 *  succeeded (warns otherwise, like the shell).
 *
 * @param vm - The running VM name.
 * @param port - The OpenChamber web port (context.openchamberPort).
 * @returns True when restarted.
 */
export async function restartOpenchamber(vm: string, port: number): Promise<boolean> {
  const res = await execVm(vm, ['sh', '-s'], { input: openchamberRestartScript(port) });
  if (res.code !== 0) {
    logger.warn(
      'could not restart OpenChamber — it will pick up the new settings on its next start.',
    );
    return false;
  }
  logger.ok('Restarted OpenChamber with the fresh environment (user settings + ~/.zprofile).');
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
 * @param vm - The running VM name.
 * @param home - The host home directory.
 * @param yes - Skip confirmations.
 * @returns The step outcome (see SettingsState).
 */
export async function ensureUserSettings(
  vm: string,
  home: string,
  yes: boolean,
): Promise<SettingsState> {
  if (await guestSettingsUpToDate(vm)) {
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
  await copySettingsToGuest(vm, files, home);
  logger.ok(`Copied ${files.length} item(s) into the guest.`);
  return 'copied';
}

/** The `sync` flow: always copies (no marker gate) + restarts OpenChamber.
 *
 * @param vm - The running VM name.
 * @param home - The host home directory.
 * @param yes - Skip confirmations.
 * @param port - The OpenChamber web port (for the service re-snapshot).
 * @returns The outcome (copied | none | declined | failed).
 */
export async function syncUserSettings(
  vm: string,
  home: string,
  yes: boolean,
  port: number,
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
  await copySettingsToGuest(vm, files, home);
  logger.ok(`Copied ${files.length} item(s) into the guest (version ${SETTINGS_VERSION}).`);
  await restartOpenchamber(vm, port);
  return 'copied';
}
