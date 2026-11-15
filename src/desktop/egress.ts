import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { BlockList, createConnection, isIPv4, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { chmod, rm } from 'node:fs/promises';
import type { Duplex } from 'node:stream';
import { normalizeNetwork, permitsDomain, type NetworkPolicy } from '../network-policy.js';

// Deliberately IPv4-only egress. The guest has IPv6 disabled and no direct
// route out. Resolve once, validate every answer, and connect to that numeric
// address so DNS rebinding cannot turn an approved lookup into a private dial.
const special = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
export function addressFilter(extra: string[] = []) {
  const blocked = new BlockList();
  for (const value of [...special, ...extra]) {
    const [address, bits = '32'] = value.split('/');
    if (!isIPv4(address!) || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) throw new Error('Invalid desktop egress IPv4 CIDR: ' + value);
    blocked.addSubnet(address!, Number(bits), 'ipv4');
  }
  for (const addresses of Object.values(networkInterfaces())) for (const item of addresses ?? []) {
    if (item.family === 'IPv4') blocked.addAddress(item.address, 'ipv4');
  }
  return (address: string) => isIPv4(address) && !blocked.check(address, 'ipv4');
}

class Denied extends Error {}
type Resolver = (hostname: string) => Promise<string[]>;
export interface EgressOptions { blockedCIDRs?: string[]; resolve?: Resolver }
export class EgressProxy {
  private server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => { void this.http(req, res); });
  private sockets = new Set<Duplex>();
  private enabled = false;
  private allowedAddress: (address: string) => boolean;
  private resolve: Resolver;
  readonly policy: NetworkPolicy;
  readonly activity = { allowed: 0, blocked: 0, last_denied: '' };
  constructor(readonly path: string, policy: NetworkPolicy, options: EgressOptions = {}) {
    this.policy = normalizeNetwork(policy);
    this.allowedAddress = addressFilter(options.blockedCIDRs);
    this.resolve = options.resolve ?? (async host => (await lookup(host, { all: true, family: 4 })).map(item => item.address));
    this.server.maxConnections = 32;
    this.server.maxRequestsPerSocket = 100;
    this.server.on('connection', socket => { this.track(socket); socket.setTimeout(60_000, () => socket.destroy()); });
    this.server.on('connect', (req, socket, head) => { void this.tunnel(req, socket, head); });
    this.server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nUse secure WebSockets over HTTPS.'));
    this.server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  }
  private track(socket: Duplex) {
    this.sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => this.sockets.delete(socket));
  }
  async start() {
    await rm(this.path, { force: true });
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve); });
    await chmod(this.path, 0o600);
    this.enabled = true;
  }
  async close() {
    this.enabled = false;
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    await rm(this.path, { force: true });
  }
  async destination(hostname: string, port: number) {
    if (!this.enabled || ![80, 443].includes(port) || !permitsDomain(this.policy, hostname)) throw new Denied('Destination is not allowed by this desktop network policy');
    const host = hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host.includes(':') || host.includes('[') || host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) throw new Denied('Local and IPv6 addresses are blocked');
    const deadline = AbortSignal.timeout(5000);
    const addresses = isIPv4(host) ? [host] : await Promise.race([this.resolve(host), new Promise<never>((_resolve, reject) => {
      deadline.addEventListener('abort', () => reject(new Error('DNS lookup timed out')), { once: true });
    })]);
    if (!addresses.length || addresses.some(address => !this.allowedAddress(address))) throw new Denied('Private, reserved, metadata and host addresses are blocked');
    if (!this.enabled) throw new Denied('Desktop network access has stopped');
    return addresses[0]!;
  }
  private failure(error: unknown, host: string) {
    const denied = error instanceof Denied;
    if (denied) { this.activity.blocked++; this.activity.last_denied = host.slice(0, 253); }
    return { code: denied ? 403 : 502, message: denied ? 'Blocked by desktop network policy. ' + (error as Error).message : 'The desktop proxy could not reach this destination.' };
  }
  private headers(input: IncomingHttpHeaders): IncomingHttpHeaders {
    const result = { ...input };
    const names = ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
      ...(input.connection ?? '').toLowerCase().split(',').map(value => value.trim())];
    for (const name of names) delete result[name];
    return result;
  }
  private async http(req: IncomingMessage, res: ServerResponse) {
    let host = '';
    try {
      const url = new URL(req.url ?? '');
      host = url.hostname;
      if (url.protocol !== 'http:' || url.username || url.password || url.hash || (url.port && url.port !== '80')) throw new Denied('Only HTTP port 80 and HTTPS CONNECT port 443 are supported');
      const ip = await this.destination(host, 80);
      if (req.destroyed || res.destroyed) return;
      this.activity.allowed++;
      const upstream = request({ host: ip, family: 4, port: 80, method: req.method,
        path: url.pathname + url.search, headers: { ...this.headers(req.headers), host: url.host, connection: 'close' }, agent: false }, response => {
        res.writeHead(response.statusCode ?? 502, this.headers(response.headers));
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('socket', socket => { this.track(socket); socket.setTimeout(30_000, () => socket.destroy()); });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain', connection: 'close' }).end('Destination unavailable.'); else res.destroy(); });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    } catch (error) {
      const failure = this.failure(error, host);
      res.writeHead(failure.code, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(failure.message);
    }
  }
  private async tunnel(req: IncomingMessage, client: Duplex, head: Buffer) {
    let host = '';
    try {
      // Parse an authority, never a URL or userinfo. IP literals are checked by
      // the same address guard; IPv6 is intentionally not supported here.
      const match = /^([^\s\/:@?#]+):443$/.exec(req.url ?? '');
      if (!match) throw new Denied('CONNECT requires a hostname on port 443');
      host = match[1]!;
      const canonical = new URL('https://' + host).hostname;
      const ip = await this.destination(canonical, 443);
      if (client.destroyed) return;
      const upstream: Socket = createConnection({ host: ip, family: 4, port: 443 });
      this.track(upstream);
      const deadline = setTimeout(() => upstream.destroy(), 10_000);
      upstream.setTimeout(60_000, () => upstream.destroy());
      upstream.once('connect', () => {
        clearTimeout(deadline);
        if (!this.enabled || client.destroyed) { upstream.destroy(); return; }
        this.activity.allowed++;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      upstream.once('close', () => { clearTimeout(deadline); client.destroy(); });
      client.once('close', () => upstream.destroy());
    } catch (error) {
      const failure = this.failure(error, host);
      client.end(`HTTP/1.1 ${failure.code} ${failure.code === 403 ? 'Forbidden' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${failure.message}`);
    }
  }
}
