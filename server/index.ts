import { createHmac } from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

const port = parseInt(process.env.PEER_PORT || '9000');
const TURN_SECRET = process.env.TURN_SECRET || 'telvy-dev-secret';
const TURN_TTL = 3600;
const TURN_DOMAIN = process.env.TURN_DOMAIN || 'localhost';

const app = express();
const httpServer = createServer(app);

// --- Rate limiting ---

const rateLimitMap = new Map<string, { count: number; reset: number }>();

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.reset) {
    rateLimitMap.set(ip, { count: 1, reset: now + 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.reset) rateLimitMap.delete(ip);
  }
}, 300_000);

// --- TURN credentials ---

app.get('/api/turn-credentials', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (rateLimit(ip)) {
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

const rooms = new Map<string, Set<WebSocket>>();
const MAX_PEERS = 2;

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');

  if (!roomId) {
    ws.close(4000, 'Missing room parameter');
    return;
  }

  // Get or create room
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }

  if (room.size >= MAX_PEERS) {
    ws.close(4001, 'Room full');
    return;
  }

  room.add(ws);

  // Notify existing peers (unencrypted control message)
  for (const peer of room) {
    if (peer !== ws && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify({ type: 'peer-joined' }));
    }
  }

  // Relay messages (server sees only encrypted blobs)
  ws.on('message', (data) => {
    const msg = data.toString();
    for (const peer of room!) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        peer.send(msg);
      }
    }
  });

  ws.on('close', () => {
    room!.delete(ws);

    // Notify remaining peers
    for (const peer of room!) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify({ type: 'peer-left' }));
      }
    }

    // Clean up empty rooms
    if (room!.size === 0) {
      rooms.delete(roomId);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Telvy server on port ${port}`);
});
