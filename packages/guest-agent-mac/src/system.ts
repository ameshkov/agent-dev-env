// system.ts — pure builders for the macOS guest agent's filesystem
// artifacts: launchd plists, ~/.zprofile blocks, ~/.ssh/config block.
// Everything is a function of its inputs so the builders are unit-testable
// without a guest. The string-level block append/remove helpers are pure
// too — the agent's index.ts does the actual file I/O.

export interface LaunchdBridge {
  /** launchd label, e.g. dev.agent-dev-env.ssh-agent. */
  label: string;
  /** node binary (process.execPath). */
  nodePath: string;
  /** the guest agent script (the bundled file). */
  agentPath: string;
  /** bridge role: ssh-agent | docker. */
  role: string;
  /** bridge port in the guest. */
  port: number;
  /** host alias the guest dials (Tart gateway / NAT router). */
  hostAlias: string;
}

export const LAUNCHD_LABELS = {
  'ssh-agent': 'dev.agent-dev-env.ssh-agent',
  docker: 'dev.agent-dev-env.docker',
} as const;

export const GUEST_AGENT_SOCKET = '/tmp/ssh-agent.sock';

export const ZPROFILE_MARKERS = {
  agent: '# SSH agent bridge to the host (see docs/ssh-agent.md)',
  env: '# Docker env vars for the host engine (testcontainers support, see docs/macos.md)',
} as const;

const SSH_CONFIG_MARKER = '# SSH agent bridge to the host (see docs/ssh-agent.md)';

/** Escapes a string for XML element content. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Builds the launchd plist for a bridge (KeepAlive on failure):
 *  ProgramArguments = node <agent> bridge <role> --port N --host-alias GW.
 *  The docker socket path is resolved at install time — launchd execs the
 *  program directly (no shell), so `$HOME` must already be expanded.
 * @param bridge - The bridge descriptor.
 * @param dockerSocketPath - The guest's docker socket (~/.docker/run/...).
 */
export function launchdPlist(bridge: LaunchdBridge, dockerSocketPath: string): string {
  const args: string[] = [
    bridge.nodePath,
    bridge.agentPath,
    'bridge',
    bridge.role,
    '--port',
    String(bridge.port),
    '--host-alias',
    bridge.hostAlias,
    '--listen',
    bridge.role === 'ssh-agent' ? `unix:${GUEST_AGENT_SOCKET}` : `unix:${dockerSocketPath}`,
    '--forward',
    `tcp:${bridge.hostAlias}:${bridge.port}`,
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${escapeXml(bridge.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    <string>${escapeXml(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>',
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The ~/.zprofile block: point shells at the bridged agent socket. */
export function zprofileAgentBlock(): string {
  return [
    '',
    ZPROFILE_MARKERS.agent,
    'if [ -z "${SSH_AUTH_SOCK:-}" ] || [ "$SSH_AUTH_SOCK" != "/tmp/ssh-agent.sock" ]; then',
    '    export SSH_AUTH_SOCK=/tmp/ssh-agent.sock',
    'fi',
    '',
    '',
  ].join('\n');
}

/** The ~/.zprofile block: exports for the host engine (testcontainers). */
export function zprofileDockerBlock(): string {
  return [
    '',
    ZPROFILE_MARKERS.env,
    'export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"',
    'export TESTCONTAINERS_HOST_OVERRIDE="$(netstat -nr | awk \'/default/{print $2; exit}\')"',
    '',
    '',
  ].join('\n');
}

/** The ~/.ssh/config block: IdentityAgent for every host. */
export function sshConfigBlock(): string {
  return ['', SSH_CONFIG_MARKER, 'Host *', '    IdentityAgent /tmp/ssh-agent.sock', '', ''].join(
    '\n',
  );
}

/** The docker `host` context sync: recreate/update it to the bridged
 *  socket and make it the default (like the legacy ensure_guest_docker-
 *  context — keep the context, refresh its endpoint, then use it).
 * @param docker - The docker CLI path (guest).
 * @param sock - The guest docker socket path.
 * @returns The argv sequences, in order.
 */
export function dockerContextArgs(docker: string, sock: string): string[][] {
  const endpoint = `host=unix://${sock}`;
  return [
    [docker, 'context', 'create', 'host', '--docker', endpoint],
    [docker, 'context', 'update', 'host', '--docker', endpoint],
    [docker, 'context', 'use', 'host'],
  ];
}

/** Appends a marker-guarded block when the marker is not present yet. The
 *  existing content is preserved; only the separator newline, if needed,
 *  plus the block are added.
 */
export function appendBlockIfMissing(content: string, block: string, marker: string): string {
  return content.includes(marker) ? content : `${content}${maybeNewline(content)}${block}`;
}

/** Removes a marker-guarded block: the leading blank separator, the
 *  marker line, the block's lines and its trailing blank line. Content
 *  after the block is preserved. */
export function removeBlock(content: string, marker: string): string {
  const lines = content.split('\n');
  const markerIndex = lines.findIndex((line) => line === marker);
  if (markerIndex === -1) {
    return content;
  }
  const blockStart =
    markerIndex > 0 && lines[markerIndex - 1] === '' ? markerIndex - 1 : markerIndex;
  let blockEnd = markerIndex + 1;
  while (blockEnd < lines.length && lines[blockEnd] !== '') {
    blockEnd += 1;
  }
  if (blockEnd < lines.length) {
    blockEnd += 1; // the block's trailing blank line
  }
  return [...lines.slice(0, blockStart), ...lines.slice(blockEnd)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function maybeNewline(content: string): string {
  return content.length === 0 || content.endsWith('\n') ? '' : '\n';
}
