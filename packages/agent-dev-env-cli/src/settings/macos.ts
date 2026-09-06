// settings/macos.ts — the macOS user-settings copy: pure builders
// (collection, .gitconfig sanitization, guest-side marker scripts) —
// port of scripts/lib/macos-settings.sh, with the marker moved to the
// green-field `~/.config/agent-dev-env/` path (AGENTS.md conventions).
//
// The IO half (tar streams over `tart exec`) lives in macos-copy.ts; this
// module stays free of process spawning so the logic is unit-testable.
// The macOS-specific bits are the version, the guest home and the guest
// unpack/restart scripts — the shared set (markers, candidate files,
// sanitization) lives in settings/common.ts.

export type { SettingsState } from './common.js';
export {
  collectSettingsFiles,
  guestSettingsCheckScript,
  guestSettingsMarkerScript,
  sanitizeGitconfig,
} from './common.js';

/** Version of the settings copy. Bump when the file set or the copy logic
 *  changes: guests whose marker is older are offered the copy again.
 */
export const SETTINGS_VERSION = 9;

/** The sandbox user in the macOS base image — fixed, so host home paths
 *  are rewritten to it when the settings are copied (see sanitize).
 */
export const GUEST_HOME = '/Users/admin';

/** The guest-side tar unpack — `sh -c` command: extract + tighten ~/.ssh.
 *
 * @returns The command text.
 */
export function guestUnpackCommand(): string {
  return 'tar -C "$HOME" -xf - || exit 1; chmod 700 "$HOME/.ssh" 2>/dev/null || true';
}

/** The image default OpenChamber web UI password (the recipe's
 *  `openchamber_ui_password` var). Used only when the service has no
 *  LaunchAgent plist yet — a configured password is read back from the
 *  existing plist and preserved (see openchamberRestartScript). */
const OPENCHAMBER_UI_PASSWORD = 'sandbox';

/** The guest-side OpenChamber re-snapshot — `sh -s` stdin script. Sources
 *  ~/.zprofile first (openchamber is npm-global via nvm, login-shell PATH
 *  only; the exports in it — OPENCHAMBER_DATA_DIR, OPENCODE_DATA_DIR, ...
 *  — should land in the new service environment too), then re-creates the
 *  launch service. A plain `openchamber restart` would keep the launchd
 *  job running with its old environment snapshot — launchd never reads
 *  shell profiles — so the vars would stay invisible to the server.
 *
 * @param port - The OpenChamber web port (context.openchamberPort).
 * @returns The script text.
 */
export function openchamberRestartScript(port: number): string {
  return [
    'if [ -f "$HOME/.zprofile" ]; then',
    '    . "$HOME/.zprofile" 2>/dev/null || true',
    'fi',
    // Preserve the currently configured UI password (a user-changed one
    // must survive the re-snapshot; `--ui-password` without a value would
    // generate a new one).
    `ui_password='${OPENCHAMBER_UI_PASSWORD}'`,
    'if [ -f "$HOME/Library/LaunchAgents/dev.openchamber.web.plist" ]; then',
    '    current="$(plutil -extract EnvironmentVariables.OPENCHAMBER_UI_PASSWORD raw \\',
    '        "$HOME/Library/LaunchAgents/dev.openchamber.web.plist" 2>/dev/null || true)"',
    '    [ -n "$current" ] && ui_password="$current"',
    'fi',
    'openchamber startup disable 2>/dev/null || true',
    `exec openchamber startup enable --port ${port} --lan --ui-password "$ui_password"`,
    '',
  ].join('\n');
}
