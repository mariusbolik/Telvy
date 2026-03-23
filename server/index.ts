import { ExpressPeerServer } from 'peer';
import { createHmac } from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';

const port = parseInt(process.env.PEER_PORT || '9000');
const TURN_SECRET = process.env.TURN_SECRET || 'telvy-dev-secret';
const TURN_TTL = 3600; // 1 hour
const TURN_DOMAIN = process.env.TURN_DOMAIN || 'localhost';

const app = express();
const httpServer = createServer(app);

// Rate limiting: max 10 requests per minute per IP
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

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.reset) rateLimitMap.delete(ip);
  }
}, 300_000);

// TURN credentials endpoint (HMAC-SHA1, time-limited)
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
      {
        urls: `turn:${TURN_DOMAIN}:3478`,
        username,
        credential,
      },
      {
        urls: `turns:${TURN_DOMAIN}:5349`,
        username,
        credential,
      },
    ],
    ttl: TURN_TTL,
  });
});

// PeerServer
const peerServer = ExpressPeerServer(httpServer, {
  path: '/peerjs',
  allow_discovery: false,
  proxied: true,
});

app.use('/', peerServer);

httpServer.listen(port, () => {
  console.log(`PeerServer + TURN API on port ${port}`);
});
