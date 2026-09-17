import { describe, expect, it } from 'vitest';
import { mapGuestPath, openCodeModelsUrlScript, SETTINGS_VERSION } from './ubuntu.js';
import { guestSettingsCheckScript } from './common.js';

describe('mapGuestPath', () => {
  it('maps the VS Code user config to the Linux .config path', () => {
    expect(mapGuestPath('Library/Application Support/Code/User/settings.json')).toBe(
      '.config/Code/User/settings.json',
    );
    expect(mapGuestPath('Library/Application Support/Code/User/snippets')).toBe(
      '.config/Code/User/snippets',
    );
  });

  it('maps mcp-compress-router to the Linux XDG data dir', () => {
    expect(mapGuestPath('Library/Application Support/mcp-compress-router')).toBe(
      '.local/share/mcp-compress-router',
    );
    expect(mapGuestPath('Library/Application Support/mcp-compress-router/mcp.json')).toBe(
      '.local/share/mcp-compress-router',
    );
  });

  it('keeps everything else at the same relative path', () => {
    expect(mapGuestPath('.config/opencode/opencode.json')).toBe('.config/opencode/opencode.json');
    expect(mapGuestPath('.copilot/config.json')).toBe('.copilot/config.json');
    expect(mapGuestPath('.ssh/known_hosts')).toBe('.ssh/known_hosts');
    expect(mapGuestPath('.gitconfig')).toBe('.gitconfig');
  });
});

describe('Ubuntu settings constants', () => {
  it('bumps the settings version for the models-URL copy logic', () => {
    expect(SETTINGS_VERSION).toBe(4);
  });

  it('embeds the green-field marker path in the check script', () => {
    const script = guestSettingsCheckScript();
    expect(script).toContain('$HOME/.config/agent-dev-env/settings-copied');
  });
});

describe('openCodeModelsUrlScript', () => {
  const url = 'https://tokenguard.int.agrd.dev/api/v1/models-dev';

  it('writes the host OPENCODE_MODELS_URL to the green-field env file', () => {
    const script = openCodeModelsUrlScript(url);
    expect(script).toContain(
      `printf "OPENCODE_MODELS_URL='%s'\\nexport OPENCODE_MODELS_URL\\n" '${url}'`,
    );
    expect(script).toContain('$HOME/.config/agent-dev-env/models-url.env');
  });

  it('points the OpenChamber systemd user service at the env file', () => {
    const script = openCodeModelsUrlScript(url);
    expect(script).toContain('agent-dev-env-openchamber.service.d/agent-dev-env-models-url.conf');
    expect(script).toContain('EnvironmentFile=%h/.config/agent-dev-env/models-url.env');
    expect(script).toContain('systemctl --user daemon-reload');
  });

  it('sources the env file from the login shells', () => {
    const script = openCodeModelsUrlScript(url);
    expect(script).toContain('. "$HOME/.config/agent-dev-env/models-url.env"');
    expect(script).toContain('"$HOME/.profile"');
    expect(script).toContain('"$HOME/.bashrc"');
    expect(script).toContain('env-ok');
  });
});
