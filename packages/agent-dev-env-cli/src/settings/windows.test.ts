import { describe, expect, it } from 'vitest';
import {
  guestApplyScript,
  guestHome,
  guestSettingsCheckScript,
  guestSettingsMarkerScript,
  mapGuestPath,
  openCodeModelsUrlScript,
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
    expect(mapGuestPath('.ssh/known_hosts')).toBe('.ssh/known_hosts');
    expect(mapGuestPath('.gitconfig')).toBe('.gitconfig');
  });
});

describe('Windows settings builders', () => {
  it('starts the settings version at 1 (fresh-guest semantics)', () => {
    expect(SETTINGS_VERSION).toBe(1);
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
    ];
    for (const script of scripts) {
      for (const char of script) {
        expect(char.charCodeAt(0)).toBeLessThan(128);
      }
    }
  });
});
