import { createHash, createHmac } from 'node:crypto';
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

const port = parseInt(process.env.PEER_PORT || '9000');
const TURN_SECRET = requireEnv('TURN_SECRET');
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

type RoomState = {
  joinProof: string;
  peers: Set<WebSocket>;
};

type ServerFrame =
  | { source: 'server'; type: 'peer-joined' | 'peer-left' }
  | { source: 'server'; type: 'signal'; payload: string };

const rooms = new Map<string, RoomState>();
const MAX_PEERS = 2;

function normalizeAdmissionProof(proof: string): string {
  return createHash('sha256')
    .update(proof)
    .digest('hex');
}

function sendServerFrame(peer: WebSocket, frame: ServerFrame) {
  peer.send(JSON.stringify(frame));
}

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room');
  const joinProof = url.searchParams.get('proof');

  if (!roomId) {
    ws.close(4000, 'Missing room parameter');
    return;
  }

  if (!joinProof) {
    ws.close(4002, 'Missing room proof');
    return;
  }

  // Get or create room
  let roomState = rooms.get(roomId);
  if (!roomState) {
    roomState = {
      joinProof: normalizeAdmissionProof(joinProof),
      peers: new Set(),
    };
    rooms.set(roomId, roomState);
  } else if (roomState.joinProof !== normalizeAdmissionProof(joinProof)) {
    ws.close(4003, 'Invalid room secret');
    return;
  }

  if (roomState.peers.size >= MAX_PEERS) {
    ws.close(4001, 'Room full');
    return;
  }

  roomState.peers.add(ws);

  // Notify existing peers with a reserved server-only control frame.
  for (const peer of roomState.peers) {
    if (peer !== ws && peer.readyState === WebSocket.OPEN) {
      sendServerFrame(peer, { source: 'server', type: 'peer-joined' });
    }
  }

  // Relay messages (server sees only encrypted blobs)
  ws.on('message', (data) => {
    const msg = data.toString();
    for (const peer of roomState!.peers) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        sendServerFrame(peer, { source: 'server', type: 'signal', payload: msg });
      }
    }
  });

  ws.on('close', () => {
    roomState!.peers.delete(ws);

    // Notify remaining peers
    for (const peer of roomState!.peers) {
      if (peer.readyState === WebSocket.OPEN) {
        sendServerFrame(peer, { source: 'server', type: 'peer-left' });
      }
    }

    // Clean up empty rooms
    if (roomState!.peers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Telvy server on port ${port}`);
});
