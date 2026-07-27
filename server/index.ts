/// <reference types="node" />
/**
 * ROYALE — authoritative multiplayer server.
 *
 *   node --experimental-strip-types server/index.ts
 *   PORT=8787 ROYALE_LOG=pretty npm run server
 *
 * One process hosts the whole lobby: 36 rooms (6 stakes × 2 variants ×
 * 3 formats), a WebSocket endpoint at `/ws`, and an HTTP health endpoint.
 *
 * The socket layer here does four things and nothing else:
 *   · frame limits, per-connection rate limiting and heartbeat liveness
 *   · identity (issue / resume a bearer player id)
 *   · validation via `protocol.decodeClient` — no raw object ever reaches a room
 *   · routing to the registry
 *
 * All game authority lives in `room.ts`. This file cannot see hole cards.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { createLogger } from './log.ts';
import type { Logger } from './log.ts';
import { TableRegistry } from './tables.ts';
import type { RoomClient } from './room.ts';
import { MAX_FRAME_BYTES, decodeClient, encode, sanitizeText } from './protocol.ts';
import type { ClientPacket, ServerPacket } from './protocol.ts';

// ═══════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════

const PORT = Number(process.env.PORT ?? process.env.ROYALE_PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const PRETTY = (process.env.ROYALE_LOG ?? '') === 'pretty';
const LOG_LEVEL = (process.env.ROYALE_LOG_LEVEL ?? 'info') as 'debug' | 'info' | 'warn' | 'error';

/** Per-connection inbound rate limit. Generous for play, fatal for floods. */
const MSG_BURST = 60;
const MSG_WINDOW_MS = 1000;
const HEARTBEAT_MS = 15_000;
const LIVENESS_MS = 45_000;
/** Drop non-critical frames when a socket is this far behind. */
const BACKPRESSURE_BYTES = 512 * 1024;

const log: Logger = createLogger({ level: LOG_LEVEL, pretty: PRETTY, base: { svc: 'royale' } });

// ═══════════════════════════════════════════════════════════════════
// Connection
// ═══════════════════════════════════════════════════════════════════

let connSeq = 0;

class Conn implements RoomClient {
  readonly cid: string;
  id: string;
  name = 'Guest';
  avatarId = 'av-01';
  level = 1;
  premium = false;
  connected = true;

  private ws: WebSocket;
  private hits: number[] = [];
  private lastSeen = Date.now();
  private greeted = false;
  private log: Logger;

  constructor(ws: WebSocket, remote: string) {
    this.ws = ws;
    this.cid = `c${(++connSeq).toString(36)}`;
    this.id = newPlayerId();
    this.log = log.child({ conn: this.cid, ip: remote });
  }

  get socket(): WebSocket {
    return this.ws;
  }

  get idle(): number {
    return Date.now() - this.lastSeen;
  }

  touch(): void {
    this.lastSeen = Date.now();
  }

  get hasGreeted(): boolean {
    return this.greeted;
  }

  greet(): void {
    this.greeted = true;
  }

  get logger(): Logger {
    return this.log;
  }

  rebindLogger(): void {
    this.log = log.child({ conn: this.cid, player: this.id });
  }

  /** Token bucket. Returns false when the connection has earned a close. */
  allow(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < MSG_WINDOW_MS);
    if (this.hits.length >= MSG_BURST) return false;
    this.hits.push(now);
    return true;
  }

  send(msg: ServerPacket): void {
    if (!this.connected) return;
    if (this.ws.readyState !== 1) return;
    // Under backpressure, keep the narrative and drop the redundant ticks —
    // the client resyncs from the next full snapshot anyway.
    if (this.ws.bufferedAmount > BACKPRESSURE_BYTES && (msg.t === 'delta' || msg.t === 'lobby')) return;
    try {
      this.ws.send(encode(msg));
    } catch (err) {
      this.log.warn('send.failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  close(code = 1000, reason = 'bye'): void {
    this.connected = false;
    try {
      this.ws.close(code, reason);
    } catch {
      /* already gone */
    }
  }
}

function newPlayerId(): string {
  return `p_${randomBytes(16).toString('hex')}`;
}

// ═══════════════════════════════════════════════════════════════════
// Server
// ═══════════════════════════════════════════════════════════════════

const registry = new TableRegistry({ log, seed: 0x0ff5eed1, tickMs: 100, lobbyMs: 3000 });
const conns = new Map<string, Conn>();
/** playerId → connection, so a reconnect can adopt its reserved seat. */
const byPlayer = new Map<string, Conn>();

const started = Date.now();
const stats = { framesIn: 0, framesRejected: 0, connections: 0, peak: 0 };

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  if (url === '/health' || url === '/healthz') {
    const body = JSON.stringify({
      ok: true,
      uptimeMs: Date.now() - started,
      connections: conns.size,
      peakConnections: stats.peak,
      tables: registry.size,
      framesIn: stats.framesIn,
      framesRejected: stats.framesRejected,
      protocol: 3,
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  if (url === '/lobby') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(registry.lobby()));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('royale: try /health or ws://…/ws\n');
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_FRAME_BYTES });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const remote =
    (typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0] : '') ||
    req.socket.remoteAddress ||
    'unknown';
  const conn = new Conn(ws, remote);
  conns.set(conn.cid, conn);
  stats.connections++;
  stats.peak = Math.max(stats.peak, conns.size);
  conn.logger.info('conn.open', { total: conns.size });

  ws.on('message', (data: unknown, isBinary: boolean) => {
    const now = Date.now();
    conn.touch();
    stats.framesIn++;
    if (!conn.allow(now)) {
      stats.framesRejected++;
      conn.logger.warn('conn.rate-limited');
      conn.send({ t: 'error', message: 'rate limit' });
      conn.close(1008, 'rate-limit');
      return;
    }
    const raw = normalizeFrame(data, isBinary);
    if (raw === null) {
      stats.framesRejected++;
      return;
    }
    const decoded = decodeClient(raw);
    if (!decoded.ok) {
      stats.framesRejected++;
      conn.logger.warn('msg.invalid', { reason: decoded.reason });
      conn.send({ t: 'error', message: `bad message: ${decoded.reason}` });
      return;
    }
    try {
      handle(conn, decoded.msg);
    } catch (err) {
      conn.logger.error('msg.handler-failed', {
        t: decoded.msg.t,
        err: err instanceof Error ? err.message : String(err),
      });
      conn.send({ t: 'error', message: 'internal error' });
    }
  });

  ws.on('pong', () => conn.touch());

  ws.on('close', (code: number) => {
    conn.connected = false;
    conns.delete(conn.cid);
    if (byPlayer.get(conn.id) === conn) byPlayer.delete(conn.id);
    registry.unregister(conn.id);
    conn.logger.info('conn.close', { code, total: conns.size });
  });

  ws.on('error', (err: Error) => {
    conn.logger.warn('conn.error', { err: err.message });
  });
});

function normalizeFrame(data: unknown, isBinary: boolean): string | Uint8Array | null {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return isBinary ? null : data;
  if (Array.isArray(data)) {
    // ws delivers fragmented frames as a Buffer[]
    let total = 0;
    for (const part of data) if (part instanceof Uint8Array) total += part.length;
    if (total === 0 || total > MAX_FRAME_BYTES) return null;
    const merged = new Uint8Array(total);
    let at = 0;
    for (const part of data) {
      if (part instanceof Uint8Array) {
        merged.set(part, at);
        at += part.length;
      }
    }
    return merged;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Message routing
// ═══════════════════════════════════════════════════════════════════

function handle(conn: Conn, msg: ClientPacket): void {
  if (!conn.hasGreeted && msg.t !== 'hello' && msg.t !== 'ping') {
    conn.send({ t: 'error', message: 'say hello first' });
    return;
  }

  switch (msg.t) {
    case 'hello': {
      conn.name = sanitizeText(msg.name, 20) || 'Guest';
      conn.avatarId = msg.avatarId || 'av-01';
      // The player id doubles as the resume token. It is 128 bits of entropy
      // and is only ever handed to the client that owns it.
      if (msg.token && /^p_[0-9a-f]{32}$/.test(msg.token)) {
        const prior = byPlayer.get(msg.token);
        if (prior && prior !== conn) prior.close(1000, 'replaced');
        conn.id = msg.token;
      }
      byPlayer.set(conn.id, conn);
      conn.rebindLogger();
      conn.greet();
      registry.register(conn);
      conn.send({ t: 'welcome', playerId: conn.id, tables: registry.lobby() });
      conn.logger.info('player.hello', { name: conn.name });
      return;
    }

    case 'join': {
      const result = registry.join(conn, msg.tableId, msg.seat, msg.buyIn);
      if (result.ok) {
        conn.send({ t: 'seated', tableId: msg.tableId, seat: result.seat, buyIn: result.buyIn });
      } else if (result.waitlist !== undefined) {
        registry.watch(conn, msg.tableId);
        conn.send({ t: 'waitlist', tableId: msg.tableId, position: result.waitlist });
      } else {
        conn.send({ t: 'error', message: result.reason });
      }
      return;
    }

    case 'quickseat': {
      const room = registry.quickSeat(msg);
      if (!room) {
        conn.send({ t: 'error', message: 'no table available' });
        return;
      }
      const result = registry.join(conn, room.id, undefined, msg.buyIn);
      if (result.ok) conn.send({ t: 'seated', tableId: room.id, seat: result.seat, buyIn: result.buyIn });
      else if (result.waitlist !== undefined) {
        registry.watch(conn, room.id);
        conn.send({ t: 'waitlist', tableId: room.id, position: result.waitlist });
      } else conn.send({ t: 'error', message: result.reason });
      return;
    }

    case 'leave': {
      const room = registry.roomOf(conn.id);
      const cashOut = registry.leave(conn.id);
      conn.send({ t: 'left', tableId: room?.id ?? '', cashOut });
      return;
    }

    case 'act': {
      const room = registry.roomOf(conn.id);
      if (!room) {
        conn.send({ t: 'reject', seq: msg.seq, handId: msg.handId, reason: 'not-at-a-table' });
        return;
      }
      room.submitAction(conn.id, msg.kind, msg.amount, msg.handId, msg.seq);
      return;
    }

    case 'sitout': {
      registry.roomOf(conn.id)?.setSitOut(conn.id, msg.on);
      return;
    }

    case 'rebuy': {
      const room = registry.roomOf(conn.id);
      if (room && !room.rebuy(conn.id, msg.amount)) conn.send({ t: 'error', message: 'rebuy refused' });
      return;
    }

    case 'timebank': {
      registry.roomOf(conn.id)?.useTimeBank(conn.id, Date.now());
      return;
    }

    case 'chat': {
      registry.roomOf(conn.id)?.chat(conn.id, msg.text);
      return;
    }

    case 'react': {
      registry.roomOf(conn.id)?.react(conn.id, msg.kind, msg.targetSeat);
      return;
    }

    case 'resync': {
      const room = registry.roomOf(conn.id);
      if (room) room.sendSnapshot(conn);
      else conn.send({ t: 'lobby', tables: registry.lobby() });
      return;
    }

    case 'lobby': {
      registry.subscribe(conn.id, msg.sub);
      if (msg.sub) conn.send({ t: 'lobby', tables: registry.lobby() });
      return;
    }

    case 'ping': {
      conn.send({ t: 'pong', ts: msg.ts });
      return;
    }

    case 'bye': {
      registry.leave(conn.id);
      conn.close(1000, 'bye');
      return;
    }

    default: {
      // Exhaustiveness: a new message type must be handled explicitly.
      const never: never = msg;
      void never;
      return;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Liveness
// ═══════════════════════════════════════════════════════════════════

const heartbeat = setInterval(() => {
  for (const conn of conns.values()) {
    if (conn.idle > LIVENESS_MS) {
      conn.logger.info('conn.stale', { idleMs: conn.idle });
      try {
        conn.socket.terminate();
      } catch {
        /* already gone */
      }
      continue;
    }
    try {
      conn.socket.ping();
    } catch {
      /* socket is closing */
    }
  }
}, HEARTBEAT_MS);

// ═══════════════════════════════════════════════════════════════════
// Boot + graceful shutdown
// ═══════════════════════════════════════════════════════════════════

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('server.shutdown', { signal, connections: conns.size });
  clearInterval(heartbeat);
  for (const conn of conns.values()) {
    conn.send({ t: 'sys', text: 'Server restarting — reconnecting', tone: 'info' });
    conn.close(1001, 'going-away');
  }
  registry.stop();
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  log.info('server.stopped', { uptimeMs: Date.now() - started });
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (err: Error) => {
  log.error('process.uncaught', { err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason: unknown) => {
  log.error('process.unhandled-rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  // A server that cannot bind must not linger as a healthy-looking process.
  log.error('server.listen-failed', { port: PORT, host: HOST, code: err.code, err: err.message });
  registry.stop();
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  log.info('server.listening', {
    port: PORT,
    host: HOST,
    ws: `ws://${HOST}:${PORT}/ws`,
    health: `http://${HOST}:${PORT}/health`,
    tables: registry.size,
    node: process.version,
  });
});

void registry.start();
