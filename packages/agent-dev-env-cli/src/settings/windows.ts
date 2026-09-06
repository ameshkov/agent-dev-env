// settings/windows.ts — the Windows user-settings copy: the pure builders
// (version, marker path, host→guest path mapping, the guest-side
// PowerShell snippets and the OpenChamber restart command). The IO half
// (stage tree → tar.gz → SFTP → psExec apply) lives in windows-copy.ts;
// this module stays free of process spawning so the mapping is
// unit-testable. The candidate file set and the .gitconfig sanitization
// are shared with macOS/Ubuntu (common.ts) — the Windows backend differs
// in version, guest-home mapping, transport (psExec + SFTP over ssh2) and
// the PowerShell guest scripts.

export type { SettingsState } from './common.js';

/** Version of the settings copy. Bump when the file set or the copy logic
 *  changes: guests whose marker is older are offered the copy again. */
export const SETTINGS_VERSION = 1;

/** The marker path inside the guest, relative to `%USERPROFILE%` (POSIX
 *  separators — the staged tree and the SFTP paths use those). */
const SETTINGS_MARKER = '.config/agent-dev-env/settings-copied';

/** The Windows guest home as git configures it (forward slashes — the
 *  .gitconfig sanitization rewrites the host home to this). The sandbox
 *  images' OpenSSH account lives under C:\Users\<username>.
 *
 * @param username - The guest user (winrm_username, `Administrator`).
 * @returns The guest home path, forward slashes.
 */
export function guestHome(username: string): string {
  return `C:/Users/${username}`;
}

/** Maps a host (macOS) settings path to the Windows guest layout. Two
 *  paths move:
 *  - the VS Code user config (macOS `Library/Application Support/Code/
 *    User/`) lands in `%APPDATA%\Code\User\` (AppData/Roaming),
 *  - the mcp-compress-router settings (also under Application Support)
 *    land in `%APPDATA%\mcp-compress-router` — its Windows data dir.
 *  Everything else keeps the same relative path under `%USERPROFILE%`
 *  (opencode uses `~/.config/opencode` and `~/.local/share/opencode` on
 *  Windows too).
 *
 * @param hostPath - The path relative to the host $HOME.
 * @returns The path relative to the guest profile, POSIX separators.
 */
export function mapGuestPath(hostPath: string): string {
  const codeUser = 'Library/Application Support/Code/User/';
  if (hostPath.startsWith(codeUser)) {
    return `AppData/Roaming/Code/User/${hostPath.slice(codeUser.length)}`;
  }
  if (hostPath.startsWith('Library/Application Support/mcp-compress-router')) {
    return 'AppData/Roaming/mcp-compress-router';
  }
  return hostPath;
}

/** The guest-side settings check — a PowerShell snippet: prints
 *  `marker-current` when the guest's settings version marker is >= the
 *  current version, `marker-stale` otherwise. The Windows OpenSSH channel
 *  never reports the remote exit code, so the outcome is purely
 *  stdout-based (the psExec convention).
 *
 * @returns The script text (ASCII).
 */
export function guestSettingsCheckScript(): string {
  return [
    `$marker = Join-Path $env:USERPROFILE '${SETTINGS_MARKER.replaceAll('/', '\\')}'`,
    `$current = [int]${SETTINGS_VERSION}`,
    'if (Test-Path $marker) {',
    '  try { $saved = [int](Get-Content $marker -Raw).Trim() } catch { $saved = -1 }',
    "  if ($saved -ge $current) { Write-Output 'marker-current' } else { Write-Output 'marker-stale' }",
    '} else {',
    "  Write-Output 'marker-stale'",
    '}',
    '',
  ].join('\n');
}

/** The guest-side marker write — a PowerShell snippet: creates the
 *  green-field marker dir and writes the current version, printing
 *  `marker-ok` on success.
 *
 * @returns The script text (ASCII).
 */
export function guestSettingsMarkerScript(): string {
  return [
    `$dir = Join-Path $env:USERPROFILE '${SETTINGS_MARKER.split('/').slice(0, -1).join('/').replaceAll('/', '\\')}'`,
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    `Set-Content -NoNewline -Path (Join-Path $dir '${SETTINGS_MARKER.split('/').pop()}') -Value '${SETTINGS_VERSION}'`,
    "Write-Output 'marker-ok'",
    '',
  ].join('\n');
}

/** The guest-side settings apply — a PowerShell snippet: extracts the
 *  staged tar.gz into `%USERPROFILE%` with the in-box bsdtar (Git's tar as
 *  fallback), deletes the archive and prints `settings-ok`; errors print
 *  `settings-fail`.
 *
 * @param username - The guest user (the archive sits in her %TEMP%).
 * @returns The script text (ASCII).
 */
export function guestApplyScript(username: string): string {
  const archive = `C:\\Users\\${username}\\AppData\\Local\\Temp\\agent-dev-env-settings.tar.gz`;
  return [
    "$tar = Join-Path $env:WINDIR 'System32\\tar.exe'",
    "if (-not (Test-Path $tar)) { $tar = 'C:\\Program Files\\Git\\usr\\bin\\tar.exe' }",
    "if (-not (Test-Path $tar)) { Write-Output 'settings-fail'; exit 1 }",
    `& $tar -xzf '${archive}' -C $env:USERPROFILE`,
    "if ($LASTEXITCODE -ne 0) { Write-Output 'settings-fail'; exit 1 }",
    'Remove-Item -Force $archive -ErrorAction SilentlyContinue',
    "Write-Output 'settings-ok'",
    '',
  ].join('\n');
}

/** The guest-side OpenCode model-registry env var — a PowerShell snippet:
 *  sets `OPENCODE_MODELS_URL` persistently for the user and appends it (if
 *  missing) to the OpenChamber `startup.env`, so the wrapper passes it to
 *  every opencode spawn. opencode fetches `${OPENCODE_MODELS_URL}/api.json`
 *  for the model registry (models.dev format) and caches it as
 *  `models-<hash>.json` — a custom registry is what makes private
 *  provider models (e.g. tokenguard) resolve in the guest. Prints
 *  `env-ok` on success.
 *
 * @param url - The registry base URL (host's OPENCODE_MODELS_URL).
 * @returns The script text (ASCII).
 */
export function openCodeModelsUrlScript(url: string): string {
  const envFile = '.config\\openchamber\\startup.env';
  return [
    `[Environment]::SetEnvironmentVariable('OPENCODE_MODELS_URL', '${url}', 'User')`,
    `$envFile = Join-Path $env:USERPROFILE '${envFile}'`,
    `if (-not (Test-Path $envFile) -or -not (Select-String -Path $envFile -SimpleMatch 'OPENCODE_MODELS_URL=' -Quiet)) {`,
    `  Add-Content -Path $envFile -Value "OPENCODE_MODELS_URL='${url}'" -Encoding UTF8`,
    '}',
    "Write-Output 'env-ok'",
    '',
  ].join('\n');
}

/** The guest-side OpenChamber restart — a PowerShell snippet: the web UI
 *  runs as the `dev.openchamber.web` ONLOGON task (see the image recipe),
 *  so restart it by ending + re-running the task; prints `restart-ok` on
 *  success.
 *
 * @returns The script text (ASCII).
 */
export function openchamberRestartCommand(): string {
  return [
    'schtasks /End /TN dev.openchamber.web 2>$null | Out-Null',
    'Start-Sleep -Seconds 2',
    'schtasks /Run /TN dev.openchamber.web 2>$null | Out-Null',
    "if ($LASTEXITCODE -eq 0) { Write-Output 'restart-ok' } else { Write-Output 'restart-fail' }",
    '',
  ].join('\n');
}
