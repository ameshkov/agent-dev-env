// forwarder.ts — the socket forwarder. Accepts connections on the listen
// endpoint and pipes each accepted connection to a freshly dialed
// connection on the forward endpoint.
//
// Semantics match the socat setup it replaces:
//   - the listener survives per-connection dial failures (a guest-side
//     socket stays up while the host engine is restarting),
//   - Unix sockets are removed before listen (unlink-early) and after
//     close, so a crashed process never leaves a stale socket file, and
//     the parent directory is created first so the listener can bind
//     wherever the role expects it (e.g. the guest's ~/.docker/run),
//   - TCP listeners use reuseaddr, so restarts don't hit TIME_WAIT.
//   - Sockets are created with allowHalfOpen, so a client that half-closes
//     its write side after a final request (exactly what the Docker CLI
//     does on the hijacked `attach`/`wait` connection) still receives the
//     daemon's trailing stream — container output and the wait response.
//     With Node's default allowHalfOpen the socket is destroyed on the
//     client FIN and those bytes are dropped, which breaks
//     `docker run` on the bridged socket.
//
// Node built-ins only — this module is bundled into guests as-is.

import net from 'node:net';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatEndpoint, type Endpoint } from './endpoints.js';

export interface ForwarderOptions {
  listen: Endpoint;
  forward: Endpoint;
  /** Log line sink (default: nothing; the CLI entry logs to stderr). */
  log?: (message: string) => void;
}

export interface RunningForwarder {
  close(): Promise<void>;
}

/** Starts the forwarder; resolves once the listener is bound. */
export function startForwarder(options: ForwarderOptions): Promise<RunningForwarder> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    forwardConnection(client, options.forward, sockets);
  });

  return bind(server, options.listen).then(() => {
    options.log?.(
      `listening on ${formatEndpoint(options.listen)} → ${formatEndpoint(options.forward)}`,
    );
    return {
      close: () => closeForwarder(server, sockets, options.listen, options.log),
    };
  });
}

function forwardConnection(client: net.Socket, target: Endpoint, sockets: Set<net.Socket>): void {
  const upstream = connectTo(target);
  sockets.add(upstream);
  upstream.on('close', () => sockets.delete(upstream));

  upstream.once('connect', () => {
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const tearDown = (): void => {
    client.destroy();
    upstream.destroy();
  };
  upstream.once('error', tearDown);
  client.once('error', () => {
    upstream.destroy();
  });
}

async function bind(server: net.Server, endpoint: Endpoint): Promise<void> {
  switch (endpoint.kind) {
    case 'unix':
      // Create the parent dir so a Unix listener can bind anywhere (e.g.
      // the guest's ~/.docker/run for the Docker bridge — the legacy
      // socat setup did the same mkdir before listening).
      mkdirSync(dirname(endpoint.path), { recursive: true });
      if (existsSync(endpoint.path)) {
        unlinkSync(endpoint.path);
      }
      await listen(server, endpoint.path);
      break;
    case 'pipe':
      await listen(server, endpoint.name);
      break;
    case 'tcp':
      await listen(server, { port: endpoint.port, host: endpoint.host });
      break;
  }
}

function listen(server: net.Server, spec: string | net.ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(spec, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function connectTo(endpoint: Endpoint): net.Socket {
  switch (endpoint.kind) {
    case 'unix':
      return net.connect({ path: endpoint.path, allowHalfOpen: true });
    case 'pipe':
      return net.connect({ path: endpoint.name, allowHalfOpen: true });
    case 'tcp':
      return net.connect({ port: endpoint.port, host: endpoint.host, allowHalfOpen: true });
  }
}

function closeForwarder(
  server: net.Server,
  sockets: Set<net.Socket>,
  listen: Endpoint,
  log?: (message: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close(() => {
      if (listen.kind === 'unix' && existsSync(listen.path)) {
        unlinkSync(listen.path);
      }
      log?.('closed');
      resolve();
    });
  });
}
