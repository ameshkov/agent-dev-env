import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_MARKER } from './common.js';
import {
  collectSettingsFiles,
  guestSettingsCheckScript,
  guestSettingsMarkerScript,
  guestUnpackCommand,
  openCodeModelsUrlScript,
  openchamberRestartScript,
  sanitizeGitconfig,
} from './macos.js';

describe('collectSettingsFiles', () => {
  it('lists only existing files, keeping the fixed order', () => {
    const home = mkdtempSync(join(tmpdir(), 'settings-'));
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{}');
    writeFileSync(join(home, '.gitconfig'), '[user]\n');
    writeFileSync(join(home, '.ssh', 'sign.sh'), '#!/bin/sh\n');

    const files = collectSettingsFiles(home);
    expect(files).toContain('.config/opencode/opencode.json');
    expect(files).toContain('.gitconfig');
    expect(files).not.toContain('.copilot/config.json');
    // the fixed list comes before the ~/.ssh glob
    expect(files.indexOf('.gitconfig')).toBeLessThan(files.indexOf('.ssh/sign.sh'));
  });

  it('collects the ~/.ssh/*.sh helpers', () => {
    const home = mkdtempSync(join(tmpdir(), 'settings-'));
    mkdirSync(join(home, '.ssh'), { recursive: true });
    writeFileSync(join(home, '.ssh', 'sign.sh'), '#!/bin/sh\n');
    writeFileSync(join(home, '.ssh', 'config'), 'Host *\n');
    expect(collectSettingsFiles(home)).toContain('.ssh/sign.sh');
  });

  it('returns an empty list for an empty home', () => {
    const home = mkdtempSync(join(tmpdir(), 'settings-'));
    expect(collectSettingsFiles(home)).toEqual([]);
  });
});

describe('sanitizeGitconfig', () => {
  it('rewrites host home paths to the guest home', () => {
    const input = [
      'signingkey = ssh-ed25519',
      'helper = /Users/ameshkov/.ssh/helper.sh',
      'email = me@example.com',
    ].join('\n');
    expect(sanitizeGitconfig(input, '/Users/ameshkov', '/Users/admin')).toBe(
      [
        'signingkey = ssh-ed25519',
        'helper = /Users/admin/.ssh/helper.sh',
        'email = me@example.com',
      ].join('\n'),
    );
  });
});

describe('guest scripts', () => {
  it('the marker check compares the marker against the version', () => {
    const script = guestSettingsCheckScript();
    expect(script).toContain(`marker="$HOME/${SETTINGS_MARKER}"`);
    expect(script).toContain('"$(cat "$marker" 2>/dev/null)" -ge "$version"');
  });

  it('the marker write targets the green-field agent-dev-env path', () => {
    const script = guestSettingsMarkerScript();
    expect(script).toContain(`printf '%s\\n' "$version" > "$HOME/${SETTINGS_MARKER}"`);
    expect(script).toContain('.config/agent-dev-env/settings-copied');
    // Regression guard: the marker must never point at the legacy path.
    expect(script).not.toContain('agent-sandbox');
  });

  it('the unpack command tightens ~/.ssh', () => {
    expect(guestUnpackCommand()).toContain('tar -C "$HOME" -xf -');
    expect(guestUnpackCommand()).toContain('chmod 700 "$HOME/.ssh"');
  });

  it('the OpenChamber restart sources ~/.zprofile and re-snapshots the service env', () => {
    const script = openchamberRestartScript(4000);
    expect(script).toContain('. "$HOME/.zprofile"');
    expect(script).toContain('openchamber startup disable');
    expect(script).toContain('openchamber startup enable --port 4000 --lan --ui-password');
    // A user-changed password must survive the re-snapshot: it is read
    // back from the existing LaunchAgent plist, not replaced.
    expect(script).toContain('plutil -extract EnvironmentVariables.OPENCHAMBER_UI_PASSWORD');
    expect(script).not.toContain('exec openchamber restart');
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

  it('sources the env file from the zsh login/interactive files', () => {
    const script = openCodeModelsUrlScript(url);
    expect(script).toContain('. "$HOME/.config/agent-dev-env/models-url.env"');
    expect(script).toContain('"$HOME/.zprofile"');
    expect(script).toContain('"$HOME/.zshrc"');
    expect(script).toContain('env-ok');
  });
});
