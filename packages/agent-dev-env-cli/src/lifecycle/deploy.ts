// deploy.ts — `agent-dev-env deploy`: pushes built images to GHCR (the
// port of scripts/deploy.sh + the three platform deploy wrappers).
// macOS images go via tart push; the qcow2/vmware artifacts go via oras
// push as OCI artifacts (the tar.gz for the VMware pair). The GHCR owner
// is resolved GHCR_OWNER → --owner → git remote → ameshkov.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { run, runChecked } from '../lib/exec.js';
import { findRepoRoot } from '../lib/git.js';
import { registryRef, resolveOwner } from '../lib/ghcr.js';
import { logger } from '../lib/logger.js';
import { buildDirLayout, duHuman, requireCmd } from './build-shared.js';
import { type CatalogImage, imageVersion, resolveRequestedImages } from './catalog.js';

/** The deploy command options. */
export interface DeployOptions {
  /** GHCR owner override (GHCR_OWNER wins over this). */
  owner?: string;
}

/** `agent-dev-env deploy [image...] [--owner OWNER]`.
 *
 * @param requested - Image names (all images when empty).
 * @param options - Owner override.
 * @returns The exit code (0 on success).
 */
export async function deployCmd(
  requested: string[] = [],
  options: DeployOptions = {},
): Promise<number> {
  const repoRoot = findRepoRoot();
  const owner = await resolveOwner({ owner: options.owner, repoRoot: repoRoot ?? undefined });
  const targets = resolveRequestedImages(requested);
  if (requested.length === 0) {
    logger.title('Deploying all images:');
    for (const image of targets) {
      logger.info(image.name);
    }
  }
  for (const image of targets) {
    await deployImage(image, owner);
  }
  return 0;
}

/** Deploys one image with its platform's flow.
 *
 * @param image - The catalog image.
 * @param owner - The resolved GHCR owner.
 */
async function deployImage(image: CatalogImage, owner: string): Promise<void> {
  switch (image.platform) {
    case 'macos':
      await deployMacos(image, owner);
      return;
    case 'windows-qemu':
      await deployQemu(image, owner);
      return;
    case 'windows-vmware':
    case 'ubuntu-vmware':
      await deployVmware(image, owner);
      return;
  }
}

/** macOS: `tart push <image> --chunk-size 3 <ref>:<ver> <ref>:latest`.
 *
 * @param image - The catalog image.
 * @param owner - The GHCR owner.
 */
async function deployMacos(image: CatalogImage, owner: string): Promise<void> {
  requireCmd('tart', 'brew install cirruslabs/tap/tart');
  const version = imageVersion(image);
  const ref = registryRef(image.name, version, owner);
  logger.title(`Pushing image: ${image.name}`);
  logger.info(`Registry: ${ref} and :latest`);
  await runChecked(
    'tart',
    tartPushArgs(image.name, ref, registryRef(image.name, 'latest', owner)),
    {
      stream: true,
    },
  );
  logger.ok(`Done: ${ref} (and :latest)`);
}

/** @internal — the tart push argv (3 MB chunks — GHCR rejects > 4 MB
 *  chunks; test-only export).
 *
 * @param imageName - The local VM image name.
 * @param versionRef - The version registry ref.
 * @param latestRef - The latest registry ref.
 * @returns The tart argv.
 */
export function tartPushArgs(imageName: string, versionRef: string, latestRef: string): string[] {
  return ['push', imageName, '--chunk-size', '3', versionRef, latestRef];
}

/** windows-qemu: oras push of the built qcow2 as an OCI artifact.
 *
 * @param image - The catalog image.
 * @param owner - The GHCR owner.
 */
async function deployQemu(image: CatalogImage, owner: string): Promise<void> {
  const dirs = buildDirLayout('windows-qemu');
  const artifact = join(dirs.output, `${image.name}.qcow2`);
  if (!existsSync(artifact)) {
    throw new Error(
      `no built image at ${artifact}\n       Build it first: agent-dev-env build ${image.name}`,
    );
  }
  requireCmd('oras', 'brew install oras');
  const version = imageVersion(image);
  const ref = `${registryRef(image.name, version, owner)},latest`;
  logger.title(`Pushing image: ${image.name}`);
  logger.info(`Registry: ${registryRef(image.name, version, owner)} and :latest`);
  logger.info(`Artifact: ${artifact} (${await duHuman(artifact)})`);
  await runChecked(
    'oras',
    orasPushArgs(ref, `${image.name}.qcow2`, 'application/vnd.agent-dev-env.qcow2'),
    {
      cwd: dirs.output,
      stream: true,
    },
  );
  logger.ok(`Done: ${registryRef(image.name, version, owner)} (and :latest)`);
}

/** @internal — the oras push argv (bare file name — oras rejects absolute
 *  paths and stores the file under the name it is given; test-only
 *  export).
 *
 * @param ref - The `registry:version,latest` ref.
 * @param file - The bare file name in the cwd.
 * @param artifactType - The OCI artifact media type.
 * @returns The oras argv.
 */
export function orasPushArgs(ref: string, file: string, artifactType: string): string[] {
  return [
    'push',
    '--artifact-type',
    artifactType,
    ref,
    `${file}:application/vnd.oci.image.layer.v1.tar`,
  ];
}

/** windows-vmware / ubuntu-vmware: tar.gz of the VM dir, then oras push.
 *
 * @param image - The catalog image.
 * @param owner - The GHCR owner.
 */
async function deployVmware(image: CatalogImage, owner: string): Promise<void> {
  const dirs = buildDirLayout(image.platform as 'windows-vmware' | 'ubuntu-vmware');
  const vmx = join(dirs.output, `${image.name}.vmx`);
  if (!existsSync(vmx)) {
    throw new Error(
      `no built image at ${vmx}\n       Build it first: agent-dev-env build ${image.name}`,
    );
  }
  const artifact = join(dirs.output, `${image.name}.tar.gz`);
  logger.step(`packing ${artifact} (excluding vmware logs)`);
  await packageVmwareTar(dirs.output, image.name, artifact);
  requireCmd('oras', 'brew install oras');
  const version = imageVersion(image);
  const ref = `${registryRef(image.name, version, owner)},latest`;
  logger.title(`Pushing image: ${image.name}`);
  logger.info(`Registry: ${registryRef(image.name, version, owner)} and :latest`);
  logger.info(`Artifact: ${artifact} (${await duHuman(artifact)})`);
  await runChecked(
    'oras',
    orasPushArgs(ref, `${image.name}.tar.gz`, 'application/vnd.agent-dev-env.vmware-vm'),
    {
      cwd: dirs.output,
      stream: true,
    },
  );
  logger.ok(`Done: ${registryRef(image.name, version, owner)} (and :latest)`);
}

/** @internal — packages the runnable VM (vmx + nvram + vmdks, no logs)
 *  into one tar.gz for oras (test-only export; consumers get a single
 *  pull artifact to extract).
 *
 * @param outputDir - Packer's output dir (cwd for the relative names).
 * @param imageName - The image name (file prefix).
 * @param artifact - The tar.gz to create.
 */
export async function packageVmwareTar(
  outputDir: string,
  imageName: string,
  artifact: string,
): Promise<void> {
  const vmdks = readdirSync(outputDir)
    .filter((file) => file.endsWith('.vmdk'))
    .sort();
  const files = [`${imageName}.vmx`, `${imageName}.nvram`, ...vmdks];
  const res = await run('tar', ['-czf', artifact, ...files], { cwd: outputDir });
  if (res.code !== 0) {
    throw new Error(`tar failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }
}
