// catalog.ts — the image catalog: discovers images from the per-image
// vars files (images/<platform>/vars/<image>.pkrvars.hcl) and maps name
// <-> platform <-> vars file <-> defaults.
//
// Replaces list_images()/find_vars_file() from scripts/build.sh,
// scripts/deploy.sh, scripts/tag.sh and the wrapper resolution in each
// runner.
//
// Roots (first match wins, deduped by image name):
//   1. the checkout's images/ — when this process runs inside a clone
//      (dev mode / repo tooling)
//   2. the bundled snapshot under dist/assets/images/ — when installed
//      from npm (the package ships everything it needs)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from '../lib/git.js';
import { PLATFORM_DIR_MAP, type Platform } from '../lib/platform.js';
import { parseVars, readQuotedVar, type VarValue } from '../lib/vars.js';

export interface CatalogImage {
  /** Image name — the vars file stem, e.g. `sandbox-macos-golden-gate`. */
  name: string;
  /** Platform id (macos | windows-qemu | windows-vmware | ubuntu-vmware). */
  platform: Platform;
  /** Absolute path of the image's vars file. */
  varsFile: string;
}

function bundledImagesRoot(): string {
  // dist/lifecycle/catalog.js -> dist/assets/images (the package ships the
  // images/ snapshot next to the compiled CLI).
  return fileURLToPath(new URL('../assets/images', import.meta.url));
}

/** @internal — The images roots to search, repo checkout first. */
export function imagesRoots(cwd: string = process.cwd()): string[] {
  const roots: string[] = [];
  const repo = findRepoRoot(cwd);
  if (repo) {
    roots.push(join(repo, 'images'));
  }
  roots.push(bundledImagesRoot());
  return [...new Set(roots)];
}

/** Vars files under <root>/<platform>/vars/*.pkrvars.hcl, sorted by image
 *  name for deterministic output. */
function varsFilesIn(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const out: string[] = [];
  for (const platformDir of readdirSync(root, { withFileTypes: true })) {
    if (!platformDir.isDirectory()) {
      continue;
    }
    const varsDir = join(root, platformDir.name, 'vars');
    if (!existsSync(varsDir)) {
      continue;
    }
    for (const entry of readdirSync(varsDir)) {
      if (entry.endsWith('.pkrvars.hcl')) {
        out.push(join(varsDir, entry));
      }
    }
  }
  return out.sort();
}

function platformForDir(dir: string): Platform {
  const platform = PLATFORM_DIR_MAP[basename(dir)];
  if (!platform) {
    throw new Error(`unknown platform directory: ${dir}`);
  }
  return platform;
}

/** Lists every image in the catalog (repo root first, deduped by name).
 *
 * @param options - Explicit images roots (defaults to checkout + bundled).
 * @returns The catalog entries, sorted by image name.
 */
export function listImages(options: { roots?: string[] } = {}): CatalogImage[] {
  const seen = new Set<string>();
  const out: CatalogImage[] = [];
  for (const root of options.roots ?? imagesRoots()) {
    for (const varsFile of varsFilesIn(root)) {
      const name = basename(varsFile, '.pkrvars.hcl');
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      out.push({
        name,
        platform: platformForDir(dirname(dirname(varsFile))),
        varsFile,
      });
    }
  }
  return out;
}

/** Looks an image up by name; throws with the shell's error message.
 *
 * @param name - The image name.
 * @param options - Catalog roots (defaults to the repo + bundled assets).
 * @returns The catalog image.
 */
export function resolveImage(name: string, options: { roots?: string[] } = {}): CatalogImage {
  const image = listImages(options).find((i) => i.name === name);
  if (!image) {
    throw new Error(
      `No vars file found for image '${name}'. ` +
        `Expected images/<platform>/vars/${name}.pkrvars.hcl`,
    );
  }
  return image;
}

/** Returns the catalog's default image for a platform.
 *
 * @param platform - The platform to look up.
 * @param options - Explicit images roots (defaults to checkout + bundled).
 * @returns The platform's catalog image.
 * @throws Error when the platform has no image in the catalog.
 */
export function defaultImageFor(
  platform: Platform,
  options: { roots?: string[] } = {},
): CatalogImage {
  const image = listImages(options).find((i) => i.platform === platform);
  if (!image) {
    throw new Error(
      `No image found for platform '${platform}' — expected ` +
        `images/<platform>/vars/*.pkrvars.hcl`,
    );
  }
  return image;
}

/** Resolves the requested image names — explicit names in order, or the
 *  whole catalog when empty (no-arg build/deploy/tag semantics).
 *
 * @param requested - Image names (empty = all images).
 * @returns The catalog images, in catalog order for "all".
 * @throws Error for an unknown name or an empty catalog.
 */
export function resolveRequestedImages(requested: string[] = []): CatalogImage[] {
  if (requested.length > 0) {
    return requested.map((name) => resolveImage(name));
  }
  const all = listImages();
  if (all.length === 0) {
    throw new Error('No images found: no vars files under images/*/vars/.');
  }
  return all;
}

const varsCache = new Map<string, Record<string, VarValue>>();

/** Parses all assignments in the image's vars file (cached per file).
 *
 * @param image - The catalog image.
 * @returns The vars file's assignments as a name → value map.
 */
export function varsFor(image: CatalogImage): Record<string, VarValue> {
  const cached = varsCache.get(image.varsFile);
  if (cached) {
    return cached;
  }
  const text = readFileSync(image.varsFile, 'utf8');
  const parsed = parseVars(text);
  varsCache.set(image.varsFile, parsed);
  return parsed;
}

/** Reads the image's image_version — required, same error as
 *  deploy.sh/tag.sh.
 *
 * @param image - The catalog image.
 * @returns The version string.
 * @throws Error when the vars file has no image_version.
 */
export function imageVersion(image: CatalogImage): string {
  const text = readFileSync(image.varsFile, 'utf8');
  const version = readQuotedVar(text, 'image_version');
  if (version === undefined) {
    throw new Error(`Could not read image_version from ${image.varsFile}`);
  }
  return version;
}
