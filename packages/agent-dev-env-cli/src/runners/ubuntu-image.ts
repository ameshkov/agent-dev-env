// runners/ubuntu-image.ts — step 1 for the Ubuntu backend: the
// ubuntu-vmware binding of the shared VMware image flow (vmware-image.ts
// + vmware-image-archive.ts). The shared modules hold the archive
// pick/extract, the base clone + the display name + the one-time hardware
// upgrade; this wrapper only binds the platform id and the
// UBUNTU_VMWARE_IMAGE override var.

import type { RunContext, RunState } from './framework.js';
import { ensureVmwareImage, vmwareWorkingVmx } from './vmware-image.js';

/** The platform id for the VMware path helpers. */
const PLATFORM = 'ubuntu-vmware' as const;

/** The working clone's vmx. */
export function ubuntuWorkingVmx(image: string, instance: string): string {
  return vmwareWorkingVmx(PLATFORM, image, instance);
}

/** Step 1: select the archive, extract the base, clone the working VM
 *  and upgrade it if the installed Fusion supports a newer hardware
 *  version.
 *
 * @param context - The run context.
 * @param state - The accumulated run state (imageArchive set here).
 */
export async function ensureUbuntuImage(context: RunContext, state: RunState): Promise<void> {
  return ensureVmwareImage(PLATFORM, 'UBUNTU_VMWARE_IMAGE', context, state);
}
