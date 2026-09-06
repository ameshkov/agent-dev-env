import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { paths } from './paths.js';
import {
  backingIdentity,
  buildQemuArgs,
  QEMU_EFI_CODE,
  QEMU_HOST_ALIAS,
  qemuBackingMarker,
  qemuEfivarsPath,
  qemuImagePath,
  qemuOverlayPath,
  qemuPidFile,
  qemuStateDir,
  qemuTpmDir,
  swtpmPidFile,
  swtpmSockPath,
} from './qemu.js';

describe('backingIdentity', () => {
  it('binds the path, size and mtime (seconds) into one marker', () => {
    expect(backingIdentity('/tmp/image.qcow2', 42, 1_700_000_123_456)).toBe(
      '/tmp/image.qcow2|42|1700000123',
    );
  });

  it('detects a rebuild at the same path via size/mtime', () => {
    const first = backingIdentity('/tmp/image.qcow2', 42, 1_700_000_000_000);
    const rebuilt = backingIdentity('/tmp/image.qcow2', 43, 1_700_000_000_999);
    expect(rebuilt).not.toBe(first);
  });
});

describe('qemu state paths', () => {
  it('derives the working-VM paths under <data>/windows-qemu/<image>', () => {
    const root = join(paths.data, 'windows-qemu', 'i');
    const instance = 'default-agent-dev-env';
    const working = join(root, 'working', instance);
    expect(qemuStateDir('i')).toBe(root);
    expect(qemuImagePath('i')).toBe(join(root, 'image', 'i.qcow2'));
    expect(qemuOverlayPath('i', instance)).toBe(join(working, 'i.qcow2'));
    expect(qemuBackingMarker('i', instance)).toBe(join(working, 'backing-image.txt'));
    expect(qemuEfivarsPath('i', instance)).toBe(join(working, 'efivars.fd'));
    expect(qemuTpmDir('i', instance)).toBe(join(working, 'tpm'));
    expect(qemuPidFile('i', instance)).toBe(join(working, 'qemu.pid'));
    expect(swtpmPidFile('i', instance)).toBe(join(working, 'swtpm.pid'));
    // The control socket must NOT live next to the (long) state paths:
    // swtpm rejects Unix socket paths over ~107 chars (sockaddr_un), and
    // the per-instance state path exceeds it on macOS. The socket is a
    // short per-image+instance key under the system temp dir.
    const key = createHash('sha1').update('i/default-agent-dev-env').digest('hex').slice(0, 12);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
    const sock = swtpmSockPath('i', instance);
    expect(sock).toBe(join(tmpdir(), `ade-sw-tpm-${uid}-${key}.sock`));
    expect(sock.length).toBeLessThan(107);
  });

  it('keys the working paths by instance', () => {
    const root = join(paths.data, 'windows-qemu', 'i');
    expect(qemuOverlayPath('i', 'ci')).toBe(join(root, 'working', 'ci', 'i.qcow2'));
    expect(qemuPidFile('i', 'ci')).toBe(join(root, 'working', 'ci', 'qemu.pid'));
    expect(qemuImagePath('i')).toBe(join(root, 'image', 'i.qcow2'));
  });
});

describe('buildQemuArgs', () => {
  const base = {
    efiCode: QEMU_EFI_CODE,
    efivars: '/state/working/efivars.fd',
    overlay: '/state/working/i.qcow2',
    tpmSock: '/state/working/swtpm.sock',
    sshPort: 2222,
    rdpPort: 3389,
    openchamberPort: 4000,
    winrmPort: 5985,
    cpuCount: 4,
    memoryMb: 8192,
    headless: false,
  };

  it('builds the exact launch_qemu wiring (virt/hvf/UEFI/swtpm/ports)', () => {
    const args = buildQemuArgs(base);
    expect(args).toContain('virt,gic-version=max');
    expect(args).toContain('hvf');
    expect(args).toContain('host');
    expect(args).toContain('4');
    expect(args).toContain('8192');
    expect(args).toContain(`if=pflash,format=raw,readonly=on,file=${QEMU_EFI_CODE}`);
    expect(args).toContain('if=pflash,format=raw,file=/state/working/efivars.fd');
    expect(args).toContain('file=/state/working/i.qcow2,if=virtio,format=qcow2');
    expect(args).toContain(
      'user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,' +
        'hostfwd=tcp:127.0.0.1:3389-:3389,' +
        'hostfwd=tcp:127.0.0.1:4000-:4000,' +
        'hostfwd=tcp:127.0.0.1:5985-:5985',
    );
    expect(args).toContain('tpm-tis-device,tpmdev=tpm0,ppi=off');
    expect(args).toContain('virtio-gpu-pci');
    expect(args).toContain('cocoa,zoom-to-fit=on');
  });

  it('swaps the cocoa display for -display none in headless mode', () => {
    expect(buildQemuArgs({ ...base, headless: true })).toContain('none');
    expect(buildQemuArgs({ ...base, headless: true })).not.toContain('cocoa,zoom-to-fit=on');
  });

  it('forwards the configurable ports when overridden', () => {
    const args = buildQemuArgs({ ...base, sshPort: 2200, rdpPort: 3399, winrmPort: 6000 });
    const netdev = args[args.indexOf('-netdev') + 1];
    expect(netdev).toContain('tcp:127.0.0.1:2200-:22');
    expect(netdev).toContain('tcp:127.0.0.1:3399-:3389');
    expect(netdev).toContain('tcp:127.0.0.1:6000-:5985');
  });
});

describe('QEMU_HOST_ALIAS', () => {
  it('is the user-mode NAT gateway the guest connects to', () => {
    expect(QEMU_HOST_ALIAS).toBe('10.0.2.2');
  });
});
