// lib/tart-guest-agent.test.ts — the guest-agent probe behavior. The
// real failure this guards (observed with Tart 2.32.1): a `tart exec`
// issued before the guest agent's RPC server is up (a freshly booted
// VM) does not fail, it waits for an answer that never comes — an
// unbounded probe then hangs the whole `run macos` flow at the guest
// agent restart step. The probe loop must bound every attempt so a
// wedged client is killed and the next attempt gets a fresh connection.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForGuestAgent } from './tart.js';

describe('waitForGuestAgent', () => {
  let fakeBinDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    fakeBinDir = mkdtempSync(join(tmpdir(), 'agent-dev-env-fake-tart-'));
    originalPath = process.env.PATH;
    // A fake `tart` whose first `exec` wedges for a minute (a request
    // that never gets an answer, like Tart against a guest agent that is
    // not up yet) and whose later calls answer `ready`.
    const attempted = join(fakeBinDir, 'attempted');
    const script =
      '#!/bin/sh\n' +
      `if [ ! -f "${attempted}" ]; then\n` +
      `  : > "${attempted}"\n` +
      '  exec sleep 60\n' +
      'fi\n' +
      'echo ready\n';
    const fakeTart = join(fakeBinDir, 'tart');
    writeFileSync(fakeTart, script);
    chmodSync(fakeTart, 0o755);
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it('kills a wedged probe and retries on a fresh connection', { timeout: 10000 }, async () => {
    const started = Date.now();
    // The injected timeout must comfortably exceed the fake's startup
    // cost (spawn + shell): if the first attempt is killed before it
    // records itself as wedged, the marker write races the timeout and
    // the test flakes under load.
    await expect(waitForGuestAgent('fake-vm', 4, 10, 1000)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
