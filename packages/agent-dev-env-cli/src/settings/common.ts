// settings/common.ts — the parts of the user-settings copy shared by the
// macOS and Ubuntu backends: the outcome enum, the guest marker paths
// (green-field ~/.config/agent-dev-env/), the host candidate file set
// (identical on both — the host is always macOS), the .gitconfig
// sanitization and the guest-side marker scripts. The per-platform bits
// live in settings/macos.ts (version 10, /Users/admin, tart transport)
// and settings/ubuntu.ts (version 4, /home/admin, ssh2 transport).

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The outcome of a settings step (kept shell-identical for the summary
 *  lines: copied | uptodate | skipped | none | failed | declined). */
export type SettingsState = 'copied' | 'uptodate' | 'skipped' | 'none' | 'failed' | 'declined';

/** @internal — Marker path inside the guest (relative to its home),
 *  embedded in the marker scripts. Exported for the co-located tests.
 */
export const SETTINGS_MARKER = '.config/agent-dev-env/settings-copied';

/** The marker's directory (relative to the guest home). */
const SETTINGS_MARKER_DIR = SETTINGS_MARKER.split('/').slice(0, -1).join('/');

/** The candidate settings paths, relative to $HOME — the same list as
 *  the shell's collect_settings_files (directories are copied whole). */
const SETTINGS_CANDIDATES = [
  '.config/opencode/opencode.json',
  '.config/opencode/opencode.jsonc',
  '.config/opencode/tui.json',
  '.config/opencode/tui.jsonc',
  '.config/opencode/agents',
  '.config/opencode/commands',
  '.config/opencode/modes',
  '.config/opencode/plugins',
  '.config/opencode/skills',
  '.config/opencode/tools',
  '.config/opencode/themes',
  '.config/opencode/package.json',
  '.config/opencode/package-lock.json',
  '.config/opencode/bun.lock',
  '.local/share/opencode/auth.json',
  '.opencodereview/config.json',
  '.copilot/config.json',
  '.copilot/skills',
  '.vscode/extensions',
  'Library/Application Support/Code/User/settings.json',
  'Library/Application Support/Code/User/keybindings.json',
  'Library/Application Support/Code/User/snippets',
  'Library/Application Support/mcp-compress-router',
  '.ssh/allowed_signers',
  '.ssh/known_hosts',
  '.gitconfig',
];

/** The host's user settings files, relative to $HOME — only existing
 *  entries, fixed list first, then the `~/.ssh/*.sh` helpers (sorted for
 *  deterministic output).
 *
 * @param home - The host home directory.
 * @returns The list of settings paths (tarable with `-C` home).
 */
export function collectSettingsFiles(home: string = homedir()): string[] {
  const files = SETTINGS_CANDIDATES.filter((path) => existsSync(join(home, path)));
  try {
    const sshScripts = readdirSync(join(home, '.ssh'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
      .map((entry) => `.ssh/${entry.name}`)
      .sort();
    files.push(...sshScripts);
  } catch {
    // no ~/.ssh — nothing to add
  }
  return files;
}

/** Rewrites host home paths to the guest home (the .gitconfig
 *  sanitization: `s|$HOME|$guest_home|g` parity, including `program`
 *  values git execs verbatim).
 *
 * @param content - The .gitconfig text.
 * @param hostHome - The host home directory (e.g. /Users/ameshkov).
 * @param guestHome - The guest home directory (/Users/admin or /home/admin).
 * @returns The sanitized content.
 */
export function sanitizeGitconfig(content: string, hostHome: string, guestHome: string): string {
  return content.split(hostHome).join(guestHome);
}

/** The guest-side marker check (exit 0 when the guest's settings version
 *  marker is >= the version passed as `$1`) — `sh -s <version>` stdin.
 *
 * @returns The script text.
 */
export function guestSettingsCheckScript(): string {
  return [
    'version=$1',
    `marker="$HOME/${SETTINGS_MARKER}"`,
    'if [ -f "$marker" ] && [ "$(cat "$marker" 2>/dev/null)" -ge "$version" ] 2>/dev/null; then',
    '    exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
}

/** The guest-side marker write — `sh -s <version>` stdin script.
 *
 * @returns The script text.
 */
export function guestSettingsMarkerScript(): string {
  return [
    'version=$1',
    `mkdir -p "$HOME/${SETTINGS_MARKER_DIR}"`,
    `printf '%s\\n' "$version" > "$HOME/${SETTINGS_MARKER}"`,
    '',
  ].join('\n');
}
