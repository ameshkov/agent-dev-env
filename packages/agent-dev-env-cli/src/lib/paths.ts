// paths.ts — the on-disk state layout, designed from scratch (XDG-aware,
// no migration from legacy paths).
//
// Resolution order (highest first):
//
//   1. AGENT_DEV_ENV_DATA_HOME / AGENT_DEV_ENV_LOG_DIR / AGENT_DEV_ENV_CACHE_DIR
//   2. XDG_DATA_HOME / XDG_STATE_HOME / XDG_CACHE_HOME — when set (on any OS)
//   3. Platform defaults:
//
//        Role   | macOS                                | Linux
//        ------ | ------------------------------------ | ----------------------------
//        Data   | ~/Library/Application Support/agent-dev-env | ~/.local/share/agent-dev-env
//        Logs   | ~/Library/Logs/agent-dev-env               | ~/.local/state/agent-dev-env
//        Cache  | ~/Library/Caches/agent-dev-env             | ~/.cache/agent-dev-env
//
// An empty value counts as unset (the shell's `${VAR:-default}` semantics),
// so "export XDG_DATA_HOME=" still falls back to the platform default.
//
// Data layout under <data> (the plan's canonical layout):
//
//   <data>/
//     build/<platform>/            packer build outputs (built image +
//                                  packer_cache + staged drivers)
//     build-context/<platform>/    materialized packer context (writable
//                                  copy of images/<platform>)
//     macos/<image>/               provenance records only (working/<instance>/
//                                  clone.json + image.json — Tart owns the
//                                  VM itself)
//     windows-qemu/<image>/        image/ (assembled pristine qcow2 + the
//                                  transient parts/ pull staging),
//                                  working/<instance>/ (overlay, efivars.fd,
//                                  tpm/, pids, socks, clone.json) + image.json
//                                  (provenance)
//     windows-vmware/<image>/      image/parts/ (the pulled chunked archive),
//                                  base/, working/<instance>/, clone.json
//                                  + image.json (provenance records)
//     ubuntu-vmware/<image>/       image/parts/, base/, working/<instance>/,
//                                  clone.json + image.json (provenance records)
//
// The pristine image cache (image/ + base/) is shared across all instances:
// one pull/extraction serves N sandboxes. Each instance's working state
// (clone/overlay, TPM, NVRAM, pidfiles) lives under working/<instance>/.
//
// macOS has no VM-state footprint by design: Tart owns the image + working
// VM (github.com/cirruslabs/tart) — only the provenance records above and
// ~/Library/Logs/agent-dev-env/tart-*.log are ours. Guest-side markers
// (~/.config/agent-dev-env/…) live inside the guests; XDG_CONFIG_HOME is
// a documented future hook, no host config file yet.

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from './platform.js';

/** The three resolved state roots. */
export interface ResolvedPaths {
  data: string;
  logs: string;
  cache: string;
}

/** Resolution overrides (env / home / platform) for tests. */
export interface PathsOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v) {
      return v;
    }
  }
  return undefined;
}

/** @internal — Resolves the three roots; deterministic and injectable for
 *  tests.
 * @param options - Env / home / platform overrides (tests).
 * @returns The data, logs, and cache roots.
 */
export function resolvePaths(options: PathsOptions = {}): ResolvedPaths {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const isDarwin = (options.platform ?? process.platform) === 'darwin';

  const defaultData = isDarwin
    ? join(home, 'Library', 'Application Support', 'agent-dev-env')
    : join(home, '.local', 'share', 'agent-dev-env');
  const defaultLogs = isDarwin
    ? join(home, 'Library', 'Logs', 'agent-dev-env')
    : join(home, '.local', 'state', 'agent-dev-env');
  const defaultCache = isDarwin
    ? join(home, 'Library', 'Caches', 'agent-dev-env')
    : join(home, '.cache', 'agent-dev-env');

  return {
    data: firstNonEmpty(env.AGENT_DEV_ENV_DATA_HOME, env.XDG_DATA_HOME) ?? defaultData,
    logs: firstNonEmpty(env.AGENT_DEV_ENV_LOG_DIR, env.XDG_STATE_HOME) ?? defaultLogs,
    cache: firstNonEmpty(env.AGENT_DEV_ENV_CACHE_DIR, env.XDG_CACHE_HOME) ?? defaultCache,
  };
}

/** The resolved roots for this process. */
export const paths = resolvePaths();

/** @internal — <data>/<platform>, the platform's state root (macOS uses
 *  it only for the provenance records; Tart owns the VM store).
 * @param platform - The platform id.
 * @returns The platform's data dir.
 */
export function platformDir(platform: Platform): string {
  return join(paths.data, platform);
}

/** <data>/build/<platform>: packer build contexts + outputs (deployable
 *  artifacts; lives under data, not cache, because deploy consumes it).
 * @param platform - The platform id.
 * @returns The platform's build dir.
 */
export function buildDir(platform: Platform): string {
  return join(paths.data, 'build', platform);
}

/** <data>/<platform>/<image> — the per-image state root.
 *
 * @param platform - The platform id.
 * @param image - The image name.
 * @returns The image's state dir.
 */
export function imageRootDir(platform: Platform, image: string): string {
  return join(paths.data, platform, image);
}

/** <data>/<platform>/<image>/image/parts — the cached VMware archive
 *  chunks (part-NNNN + parts.json; the runner's pull cache; shared
 *  across instances; status/deploy read it too).
 *
 * @param platform - The platform id.
 * @param image - The image name.
 * @returns The cached parts directory.
 */
export function vmwarePartsDir(platform: Platform, image: string): string {
  return join(imageRootDir(platform, image), 'image', 'parts');
}

/** <data>/<platform>/<image>/working — the per-instance working state dir
 *  (one subdir per sandbox instance).
 *
 * @param platform - The platform id.
 * @param image - The image name.
 * @returns The instances dir.
 */
function instancesDir(platform: Platform, image: string): string {
  return join(imageRootDir(platform, image), 'working');
}

/** <data>/<platform>/<image>/working/<instance> — one sandbox instance's
 *  state root (VMware clone, QEMU overlay/TPM/NVRAM, pidfiles, clone.json).
 *
 * @param platform - The platform id.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The instance's state dir.
 */
export function instanceDir(platform: Platform, image: string, instance: string): string {
  return join(instancesDir(platform, image), instance);
}

/** <data>/<platform>/<image>/working/<instance>/<image>.vmx — the VMware
 *  working clone (the vmx path the runners/stop/delete flows derive).
 *
 * @param platform - The platform id.
 * @param image - The image name.
 * @param instance - The instance name.
 * @returns The working vmx path.
 */
export function workingVmxPath(platform: Platform, image: string, instance: string): string {
  return join(instanceDir(platform, image, instance), `${image}.vmx`);
}

/** The instance names that already have working state under an image.
 *  Covers the default instance ('default-agent-dev-env') plus any
 *  SANDBOX_VM one.
 *
 * @param platform - The platform id.
 * @param image - The image name.
 * @returns The instance names (sorted; empty when none exist yet).
 */
export function listInstances(platform: Platform, image: string): string[] {
  const dir = instancesDir(platform, image);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
