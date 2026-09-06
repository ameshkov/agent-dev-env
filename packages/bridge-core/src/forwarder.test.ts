import net from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEndpoint } from './endpoints.js';
import { startForwarder, type RunningForwarder } from './forwarder.js';
import { canConnect } from './probe.js';

/** Echoes everything back — stands in for the SSH agent / Docker engine. */
function echoServer(): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.pipe(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** A supposedly-free TCP port (bind ephemeral, read port, close). */
async function freePort(): Promise<number> {
  const server = await echoServer();
  const address = server.address() as net.AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function roundTrip(
  connect: (cb: (err: Error | null, got: string) => void) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    connect((err, got) => (err ? reject(err) : resolve(got)));
  });
}

/** Like roundTrip, but fails fast when the response never arrives. */
async function roundTripWithTimeout(
  connect: (cb: (err: Error | null, got: string) => void) => void,
): Promise<string> {
  return Promise.race([
    roundTrip(connect),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('target response never reached the client')), 2000).unref();
    }),
  ]);
}

describe('startForwarder', () => {
  let root: string;
  let running: RunningForwarder | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bridge-forwarder-'));
  });

  afterEach(async () => {
    if (running) {
      await running.close();
      running = undefined;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('forwards a unix socket listener to a TCP target (guest-side shape)', async () => {
    const target = await echoServer();
    const { port } = target.address() as net.AddressInfo;
    const sock = join(root, 'agent.sock');

    running = await startForwarder({
      listen: parseEndpoint(`unix:${sock}`),
      forward: parseEndpoint(`tcp:127.0.0.1:${port}`),
    });
    expect(existsSync(sock)).toBe(true);

    const got = await roundTrip((cb) => {
      const client = net.connect({ path: sock }, () => {
        client.write('ping\n');
      });
      let data = '';
      client.once('data', (d) => {
        data += d.toString();
        client.end();
        cb(null, data);
      });
      client.once('error', cb);
    });
    expect(got).toBe('ping\n');
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it('forwards a TCP listener to a unix socket target (host-side shape)', async () => {
    const sock = join(root, 'engine.sock');
    const target = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => target.listen(sock, () => resolve()));
    const port = await freePort();

    running = await startForwarder({
      listen: parseEndpoint(`tcp:127.0.0.1:${port}`),
      forward: parseEndpoint(`unix:${sock}`),
    });

    const got = await roundTrip((cb) => {
      const client = net.connect({ port, host: '127.0.0.1' }, () => {
        client.write('pong\n');
      });
      let data = '';
      client.once('data', (d) => {
        data += d.toString();
        client.end();
        cb(null, data);
      });
      client.once('error', cb);
    });
    expect(got).toBe('pong\n');
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it('delivers target data sent after the client half-closes (Docker attach)', async () => {
    // The Docker CLI half-closes the TCP connection right after sending the
    // /wait request over the hijacked attach connection; the daemon then
    // streams the container output and the wait response over the same
    // connection. The forwarder must keep the write side of the client
    // socket alive on the client FIN (allowHalfOpen), or that trailing
    // data is dropped and `docker run` reports success with no output.
    const sock = join(root, 'engine.sock');
    const target = net.createServer((socket) => {
      socket.once('data', () => socket.end('late-response\n'));
    });
    await new Promise<void>((resolve) => target.listen(sock, () => resolve()));
    const port = await freePort();

    running = await startForwarder({
      listen: parseEndpoint(`tcp:127.0.0.1:${port}`),
      forward: parseEndpoint(`unix:${sock}`),
    });

    const got = await roundTripWithTimeout((cb) => {
      const client = net.connect({ port, host: '127.0.0.1' }, () => {
        client.write('request\n');
        // Half-close: signal the request is complete, then keep reading.
        client.end();
      });
      let data = '';
      client.on('data', (d) => (data += d.toString()));
      client.once('end', () => cb(null, data));
      client.once('error', cb);
    });
    expect(got).toBe('late-response\n');
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it('keeps the listener alive when the forward target is down', async () => {
    const deadPort = await freePort();
    const sock = join(root, 'agent.sock');

    running = await startForwarder({
      listen: parseEndpoint(`unix:${sock}`),
      forward: parseEndpoint(`tcp:127.0.0.1:${deadPort}`),
    });

    // The accepted connection closes (dial failure), but the listener
    // stays up for a later retry.
    const closed = await roundTrip((cb) => {
      const client = net.connect({ path: sock });
      client.once('error', () => cb(null, ''));
      client.once('close', () => cb(null, ''));
    });
    expect(closed).toBe('');
    expect(await canConnect(parseEndpoint(`unix:${sock}`))).toBe(true);
  });

  it('creates missing parent directories for a unix listener', async () => {
    const sock = join(root, 'nested', 'deeper', 'agent.sock');
    const target = await echoServer();
    const { port } = target.address() as net.AddressInfo;

    running = await startForwarder({
      listen: parseEndpoint(`unix:${sock}`),
      forward: parseEndpoint(`tcp:127.0.0.1:${port}`),
    });
    expect(await canConnect(parseEndpoint(`unix:${sock}`))).toBe(true);
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it('replaces a stale unix socket file before listening', async () => {
    const sock = join(root, 'agent.sock');
    writeFileSync(sock, 'stale');
    const target = await echoServer();
    const { port } = target.address() as net.AddressInfo;

    running = await startForwarder({
      listen: parseEndpoint(`unix:${sock}`),
      forward: parseEndpoint(`tcp:127.0.0.1:${port}`),
    });
    expect(await canConnect(parseEndpoint(`unix:${sock}`))).toBe(true);
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it('removes the unix socket file when closed', async () => {
    const sock = join(root, 'agent.sock');
    const target = await echoServer();
    const { port } = target.address() as net.AddressInfo;

    const fwd = await startForwarder({
      listen: parseEndpoint(`unix:${sock}`),
      forward: parseEndpoint(`tcp:127.0.0.1:${port}`),
    });
    expect(existsSync(sock)).toBe(true);
    await fwd.close();
    expect(existsSync(sock)).toBe(false);
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
});
