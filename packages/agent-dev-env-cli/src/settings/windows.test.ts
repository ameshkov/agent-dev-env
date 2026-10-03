import { describe, expect, it } from 'vitest';
import {
  guestApplyScript,
  guestHome,
  guestSettingsCheckScript,
  guestSettingsMarkerScript,
  mapGuestPath,
  openCodeModelsUrlScript,
  openCodeServiceRestartCommand,
  openchamberRestartCommand,
  SETTINGS_VERSION,
} from './windows.js';

describe('mapGuestPath', () => {
  it('maps the VS Code user config to the Windows AppData path', () => {
    expect(mapGuestPath('Library/Application Support/Code/User/settings.json')).toBe(
      'AppData/Roaming/Code/User/settings.json',
    );
    expect(mapGuestPath('Library/Application Support/Code/User/snippets')).toBe(
      'AppData/Roaming/Code/User/snippets',
    );
  });

  it('maps mcp-compress-router to the Windows AppData dir', () => {
    expect(mapGuestPath('Library/Application Support/mcp-compress-router')).toBe(
      'AppData/Roaming/mcp-compress-router',
    );
    expect(mapGuestPath('Library/Application Support/mcp-compress-router/mcp.json')).toBe(
      'AppData/Roaming/mcp-compress-router',
    );
  });

  it('keeps everything else at the same relative path', () => {
    expect(mapGuestPath('.config/opencode/opencode.json')).toBe('.config/opencode/opencode.json');
    expect(mapGuestPath('.local/share/opencode/auth.json')).toBe('.local/share/opencode/auth.json');
    expect(mapGuestPath('.copilot/config.json')).toBe('.copilot/config.json');
    expect(mapGuestPath('.agents')).toBe('.agents');
    expect(mapGuestPath('.ssh/known_hosts')).toBe('.ssh/known_hosts');
    expect(mapGuestPath('.gitconfig')).toBe('.gitconfig');
  });
});

describe('Windows settings builders', () => {
  it('bumps the settings version for the OpenCode service restart logic', () => {
    expect(SETTINGS_VERSION).toBe(4);
  });

  it('computes the guest home with forward slashes', () => {
    expect(guestHome('Administrator')).toBe('C:/Users/Administrator');
  });

  it('embeds the green-field marker path in the check script', () => {
    expect(guestSettingsCheckScript()).toContain('.config\\agent-dev-env\\settings-copied');
  });

  it('writes the current version to the marker', () => {
    const script = guestSettingsMarkerScript();
    expect(script).toContain(`-Value '${SETTINGS_VERSION}'`);
    expect(script).toContain('settings-copied');
  });

  it('extracts the archive into %USERPROFILE% with the in-box tar', () => {
    const script = guestApplyScript('Administrator');
    expect(script).toContain('System32\\tar.exe');
    expect(script).toContain('agent-dev-env-settings.tar.gz');
    expect(script).toContain('-C $env:USERPROFILE');
  });

  it('restarts OpenChamber through its scheduled task', () => {
    const script = openchamberRestartCommand();
    expect(script).toContain('/TN dev.openchamber.web');
    expect(script).toContain('restart-ok');
  });

  it('restarts the OpenCode background service through its shim', () => {
    const script = openCodeServiceRestartCommand();
    expect(script).toContain('$openCode service restart');
    expect(script).toContain('opencode-restart-ok');
    expect(script).toContain('opencode-restart-fail');
    // The shim is resolved from PATH with the image's npm prefix as the
    // fallback (a fresh sshd session can still miss the machine PATH).
    expect(script).toContain('Get-Command opencode.cmd');
    expect(script).toContain("Join-Path $env:APPDATA 'npm\\opencode.cmd'");
    // The SSH session predates the user-scope registry write, so the
    // restart re-reads OPENCODE_MODELS_URL into the process env.
    expect(script).toContain(
      "[Environment]::GetEnvironmentVariable('OPENCODE_MODELS_URL', 'User')",
    );
    expect(script).toContain('$env:OPENCODE_MODELS_URL = $modelsUrl');
  });

  it('sets the host OPENCODE_MODELS_URL for the user + OpenChamber', () => {
    const url = 'https://tokenguard.int.agrd.dev/api/v1/models-dev';
    const script = openCodeModelsUrlScript(url);
    expect(script).toContain(`SetEnvironmentVariable('OPENCODE_MODELS_URL', '${url}', 'User')`);
    expect(script).toContain('startup.env');
    expect(script).toContain(`OPENCODE_MODELS_URL='${url}'`);
    expect(script).toContain('env-ok');
  });

  it('keeps the guest scripts ASCII-only (the PowerShell transport rule)', () => {
    const scripts = [
      guestSettingsCheckScript(),
      guestSettingsMarkerScript(),
      guestApplyScript('Administrator'),
      openCodeModelsUrlScript('https://tokenguard.int.agrd.dev/api/v1/models-dev'),
      openchamberRestartCommand(),
      openCodeServiceRestartCommand(),
    ];
    for (const script of scripts) {
      for (const char of script) {
        expect(char.charCodeAt(0)).toBeLessThan(128);
      }
    }
  });
});
