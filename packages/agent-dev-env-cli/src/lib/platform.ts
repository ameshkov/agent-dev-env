// platform.ts — the platform registry: platform ids, the images/ directory
// name for each, and the run-time defaults the shell scripts hardcoded
// (VM/image names, bridge ports, VM resources, download hints).

export const PLATFORMS = ['macos', 'windows-qemu', 'windows-vmware', 'ubuntu-vmware'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** images/<dir> name -> platform id. The image-name/platform naming scheme
 *  is fixed (AGENTS.md conventions); never introduce a separate one. */
export const PLATFORM_DIR_MAP: Record<string, Platform> = {
  mac: 'macos',
  'windows-arm64-qemu': 'windows-qemu',
  'windows-arm64-vmware': 'windows-vmware',
  'ubuntu-arm64-vmware': 'ubuntu-vmware',
};

/** Static defaults per platform (the shell scripts' hardcoded values). */
export interface PlatformDefaults {
  /** Default image name (catalog default; --image/SANDBOX_IMAGE override). */
  image: string;
  /** Dir name under the data root. */
  stateDir: string;
  /** TCP ports for the bridges/guest services (SANDBOX_* overrides). */
  agentPort: number;
  dockerPort: number;
  openchamberPort: number;
  sshPort?: number;
  rdpPort?: number;
  winrmPort?: number;
  /** VM resources for a freshly created working VM. */
  cpuCount: number;
  memoryMb: number;
  /** macOS shared-directory defaults (Tart --dir). */
  workDir?: string;
  mountName?: string;
  /** Feature flags (mirror of what each shell runner supports). */
  supportsAgentRules: boolean;
  supportsSettings: boolean;
  supportsSync: boolean;
  supportsPristineDelete: boolean;
  /** One-time download hint for pull prompts. */
  downloadHint: string;
}

export const PLATFORM_DEFAULTS: Record<Platform, PlatformDefaults> = {
  macos: {
    image: 'sandbox-macos-tahoe',
    stateDir: 'macos',
    agentPort: 4100,
    dockerPort: 4101,
    openchamberPort: 4000,
    cpuCount: 8,
    memoryMb: 16384,
    workDir: '/Volumes/dev',
    mountName: 'dev',
    supportsAgentRules: true,
    supportsSettings: true,
    supportsSync: true,
    supportsPristineDelete: true,
    downloadHint: '~50 GB',
  },
  'windows-qemu': {
    image: 'sandbox-windows-11-arm64-qemu',
    stateDir: 'windows-qemu',
    agentPort: 4200,
    dockerPort: 4201,
    openchamberPort: 4000,
    sshPort: 2222,
    rdpPort: 3389,
    winrmPort: 5985,
    cpuCount: 4,
    memoryMb: 8192,
    supportsAgentRules: false,
    supportsSettings: true,
    supportsSync: true,
    supportsPristineDelete: false,
    downloadHint: '~14 GB',
  },
  'windows-vmware': {
    image: 'sandbox-windows-11-arm64-vmware',
    stateDir: 'windows-vmware',
    agentPort: 4300,
    dockerPort: 4301,
    openchamberPort: 4000,
    cpuCount: 4,
    memoryMb: 8192,
    supportsAgentRules: false,
    supportsSettings: true,
    supportsSync: true,
    supportsPristineDelete: false,
    downloadHint: '~20 GB',
  },
  'ubuntu-vmware': {
    image: 'sandbox-ubuntu-24-04-arm64-vmware',
    stateDir: 'ubuntu-vmware',
    agentPort: 4400,
    dockerPort: 4401,
    openchamberPort: 4000,
    cpuCount: 4,
    memoryMb: 8192,
    supportsAgentRules: true,
    supportsSettings: true,
    supportsSync: true,
    supportsPristineDelete: false,
    downloadHint: '~15 GB',
  },
};

/** Whether the string names a supported platform.
 *
 * @param value - The candidate platform id.
 * @returns True when it is a known platform.
 */
export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}
