// settings/ubuntu.ts — the Ubuntu user-settings copy: the pure builders
// (version, guest home, host→guest path mapping) — port of
// scripts/lib/ubuntu-vmware/settings.sh, with the marker moved to the
// green-field `~/.config/agent-dev-env/` path (AGENTS.md conventions).
//
// The IO half (stage tree → tar.gz → sftp → unpack over ssh2) lives in
// ubuntu-copy.ts; this module stays free of process spawning so the
// mapping is unit-testable. The candidate file set, the marker scripts
// and the .gitconfig sanitization are shared with macOS (common.ts) —
// the two backends differ in version, guest home and transport only.

export type { SettingsState } from './common.js';
export {
  collectSettingsFiles,
  guestSettingsCheckScript,
  guestSettingsMarkerScript,
} from './common.js';

/** Version of the settings copy. Bump when the file set or the copy logic
 *  changes: guests whose marker is older are offered the copy again.
 *  Version 4 adds the OPENCODE_MODELS_URL write (see
 *  openCodeModelsUrlScript) — existing guests get the copy offered again
 *  so the variable reaches sandboxes copied by an older CLI. */
export const SETTINGS_VERSION = 4;

/** The sandbox user in the Ubuntu base image — fixed, so host home paths
 *  are rewritten to it when the settings are copied (see sanitize). */
export const GUEST_HOME = '/home/admin';

/** Maps a host (macOS) settings path to the guest (Linux) layout. Two
 *  paths move on Linux:
 *  - the VS Code user config (macOS `Library/Application Support/Code/
 *    User/`) lands in `~/.config/Code/User/`,
 *  - the mcp-compress-router settings (also under Library/Application
 *    Support/) land in `~/.local/share/mcp-compress-router/` — its Linux
 *    XDG *data* dir, the only place it reads mcp.json/.jsonc from.
 *  Everything else keeps the same relative path.
 *
 * @param hostPath - The path relative to the host $HOME.
 * @returns The path relative to the guest home.
 */
export function mapGuestPath(hostPath: string): string {
  const codeUser = 'Library/Application Support/Code/User/';
  if (hostPath.startsWith(codeUser)) {
    return `.config/Code/User/${hostPath.slice(codeUser.length)}`;
  }
  if (hostPath.startsWith('Library/Application Support/mcp-compress-router')) {
    return '.local/share/mcp-compress-router';
  }
  return hostPath;
}

/** The guest-side settings unpack + cleanup — `sh -c` over ssh exec.
 *  Runs with the user's password piped into `sudo -S` (legacy flow: the
 *  image up to this release shipped root-owned ~/.local).
 *
 * @param password - The guest user's password (sudo -S input).
 * @returns The script text.
 */
export function guestUnpackScript(password: string): string {
  return [
    'printf "%s\\n" "' +
      password +
      '" | sudo -S chown -R "$USER:$USER" "$HOME/.local" 2>/dev/null || true',
    'tar -C "$HOME" -xzf /tmp/agent-dev-env-settings.tar.gz || exit 1',
    'rm -rf "$HOME/.config/mcp-compress-router" 2>/dev/null || true',
    'find "$HOME/.local" "$HOME/.config" "$HOME/.copilot" "$HOME/.opencodereview" "$HOME/.ssh" ' +
      '-name "._*" -delete 2>/dev/null || true',
    'chmod 700 "$HOME/.ssh" 2>/dev/null || true',
    'rm -f /tmp/agent-dev-env-settings.tar.gz',
    '',
  ].join('\n');
}

/** The guest-side OpenChamber restart (the systemd user service; the
 *  login-shell PATH comes from /etc/profile.d at boot).
 *
 * @returns The script text.
 */
export function openchamberRestartCommand(): string {
  return 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"; systemctl --user restart agent-dev-env-openchamber';
}

/** The guest-side OPENCODE_MODELS_URL write — a POSIX sh script: writes
 *  the value to a green-field env file, points the OpenChamber systemd
 *  user service at it with a drop-in (`EnvironmentFile=`), sources the
 *  file from the login shells and reloads the user manager so the
 *  OpenChamber restart picks the variable up. The env file's
 *  `export OPENCODE_MODELS_URL` line is what shells need to pass the
 *  variable to child processes; systemd ignores it (no `=`). opencode
 *  fetches `${OPENCODE_MODELS_URL}/api.json` for the model registry
 *  (models.dev format) — a custom registry is what makes private provider
 *  models (e.g. tokenguard) resolve in the guest. Prints `env-ok` on
 *  success.
 *
 * @param url - The registry base URL (the host's OPENCODE_MODELS_URL).
 * @returns The script text.
 */
export function openCodeModelsUrlScript(url: string): string {
  const envFile = '.config/agent-dev-env/models-url.env';
  const dropIn =
    '.config/systemd/user/agent-dev-env-openchamber.service.d/agent-dev-env-models-url.conf';
  return [
    'set -e',
    'export XDG_RUNTIME_DIR="/run/user/$(id -u)"',
    'mkdir -p "$HOME/.config/systemd/user/agent-dev-env-openchamber.service.d" "$HOME/.config/agent-dev-env"',
    `printf "OPENCODE_MODELS_URL='%s'\\nexport OPENCODE_MODELS_URL\\n" '${url}' > "$HOME/${envFile}"`,
    `printf '%s\\n' '[Service]' 'EnvironmentFile=%h/${envFile}' > "$HOME/${dropIn}"`,
    'touch "$HOME/.profile" "$HOME/.bashrc"',
    'for rc in "$HOME/.profile" "$HOME/.bashrc"; do',
    `  grep -q 'agent-dev-env/models-url.env' "$rc" 2>/dev/null || printf '\\n# Agent dev env models registry\\n. "$HOME/${envFile}"\\n' >> "$rc"`,
    'done',
    'systemctl --user daemon-reload',
    "printf '%s\\n' 'env-ok'",
    '',
  ].join('\n');
}
