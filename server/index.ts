import { createHmac } from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

type RateLimitEntry = {
  count: number;
  reset: number;
};

type ServerFrame =
  | { source: 'server'; type: 'peer-joined' | 'peer-left' }
  | { source: 'server'; type: 'signal'; payload: string };

const ROOM_TAG_PATTERN = /^[a-f0-9]{64}$/;
const MAX_PEERS = 2;
const TURN_RATE_LIMIT = 10;
const JOIN_IP_RATE_LIMIT = 20;
const JOIN_ROOM_RATE_LIMIT = 12;
const RATE_LIMIT_WINDOW_MS = 60_000;

const port = parseInt(process.env.PEER_PORT || '9000');
const TURN_SECRET = requireEnv('TURN_SECRET');
const TURN_TTL = 3600;
const TURN_DOMAIN = process.env.TURN_DOMAIN || 'localhost';

const app = express();
const httpServer = createServer(app);

const turnRateLimits = new Map<string, RateLimitEntry>();
const joinIpRateLimits = new Map<string, RateLimitEntry>();
const joinRoomRateLimits = new Map<string, RateLimitEntry>();
const rooms = new Map<string, Set<WebSocket>>();

function exceedsRateLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  limit: number,
): boolean {
  const now = Date.now();
  const entry = store.get(key);

  if (!entry || now > entry.reset) {
    store.set(key, { count: 1, reset: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > limit;
}

function pruneRateLimits() {
  const now = Date.now();
  for (const store of [turnRateLimits, joinIpRateLimits, joinRoomRateLimits]) {
    for (const [key, entry] of store) {
      if (now > entry.reset) store.delete(key);
    }
  }
}

function sendServerFrame(peer: WebSocket, frame: ServerFrame) {
  peer.send(JSON.stringify(frame));
}

setInterval(pruneRateLimits, 300_000);

// --- TURN credentials ---

app.get('/api/turn-credentials', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (exceedsRateLimit(turnRateLimits, ip, TURN_RATE_LIMIT)) {
    res.status(429).json({ error: 'Too many requests' });
    return;
  }

  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL;
  const username = `${expiry}`;
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');

  res.set('Cache-Control', 'no-store');
  res.json({
    iceServers: [
      { urls: `stun:${TURN_DOMAIN}:3478` },
      { urls: `turn:${TURN_DOMAIN}:3478`, username, credential },
      { urls: `turns:${TURN_DOMAIN}:5349`, username, credential },
    ],
    ttl: TURN_TTL,
  });
});

// --- WebSocket signaling relay ---

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const roomTag = url.searchParams.get('roomTag');
  const ip = req.socket.remoteAddress || 'unknown';

  if (!roomTag || !ROOM_TAG_PATTERN.test(roomTag)) {
    ws.close(4000, 'Missing room tag');
    return;
  }

  if (
    exceedsRateLimit(joinIpRateLimits, ip, JOIN_IP_RATE_LIMIT) ||
    exceedsRateLimit(joinRoomRateLimits, roomTag, JOIN_ROOM_RATE_LIMIT)
  ) {
    ws.close(4004, 'Too many join attempts');
    return;
  }

  let room = rooms.get(roomTag);
  if (!room) {
    room = new Set();
    rooms.set(roomTag, room);
  }

  if (room.size >= MAX_PEERS) {
    ws.close(4001, 'Room full');
    return;
  }

  room.add(ws);

  for (const peer of room) {
    if (peer !== ws && peer.readyState === WebSocket.OPEN) {
      sendServerFrame(peer, { source: 'server', type: 'peer-joined' });
    }
  }

  ws.on('message', (data) => {
    const payload = data.toString();
    for (const peer of room!) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        sendServerFrame(peer, { source: 'server', type: 'signal', payload });
      }
    }
  });

  ws.on('close', () => {
    room!.delete(ws);

    for (const peer of room!) {
      if (peer.readyState === WebSocket.OPEN) {
        sendServerFrame(peer, { source: 'server', type: 'peer-left' });
      }
    }

    if (room!.size === 0) {
      rooms.delete(roomTag);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Telvy server on port ${port}`);
});
