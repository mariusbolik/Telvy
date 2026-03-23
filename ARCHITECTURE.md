# Telvy Architecture

Secure peer-to-peer audio and video calls. No signup, no database, no stored data. Fully self-hosted on a Swiss VPS.

## Tech Stack

- **Astro 6** — Static site generator (HTML/CSS/JS, no SSR)
- **PeerJS** — WebRTC client library (handles signaling, offers/answers, ICE)
- **PeerServer** — Signaling server (Express-based, runs on Bun)
- **coturn** — STUN/TURN relay server (self-hosted, HMAC credentials)
- **Tailwind CSS v4** — Styling via `@tailwindcss/vite` plugin
- **Bun** — Runtime, package manager, task runner

## No External Services

All infrastructure is self-hosted on a single Swiss VPS. No third-party servers are contacted:

- No Google STUN
- No Cloudflare
- No CDN
- No analytics or tracking

## How a Call Works

```
┌──────────┐                                              ┌──────────┐
│ Browser A │                                              │ Browser B │
└────┬─────┘                                              └─────┬────┘
     │                                                          │
     │  1. Fetch HMAC TURN credentials                          │
     │         ┌────────────────────┐                           │
     ├────────►│ /api/turn-creds    │◄──────────────────────────┤
     │         └────────────────────┘                           │
     │                                                          │
     │  2. PeerJS signaling (WebSocket over TLS)                │
     │         ┌────────────────────┐                           │
     ├────────►│ PeerServer (9000)  │◄──────────────────────────┤
     │         └────────────────────┘                           │
     │                                                          │
     │  3. STUN/TURN via coturn                                 │
     │         ┌────────────────────┐                           │
     ├────────►│ coturn (3478/5349) │◄──────────────────────────┤
     │         └────────────────────┘                           │
     │                                                          │
     │  4. Encrypted media (relayed through TURN)               │
     │◄══════════ DTLS-SRTP + AES-256-GCM E2EE ═══════════════►│
     │                                                          │
```

### Step by Step

1. **Room creation** — User clicks the orb on the landing page. JavaScript generates a word-based room ID (e.g. `brave-azure-dolphin`) using `unique-names-generator`, updates the URL to `?room=<id>`, and registers as a PeerJS peer with that ID.

2. **TURN credentials** — Before connecting, the client fetches time-limited HMAC credentials from `/api/turn-credentials`. The server generates `username = expiry_timestamp`, `credential = HMAC-SHA1(secret, username)`. These expire after 1 hour. The endpoint is rate-limited to 10 requests per minute per IP.

3. **Joining** — The second user opens the shared link (`?room=brave-azure-dolphin`). Their client tries to register with the same peer ID — PeerServer responds with `unavailable-id`. The client then creates an anonymous peer and calls the room ID directly.

4. **Signaling** — PeerJS handles the WebRTC signaling (SDP offers/answers, ICE candidates) via WebSocket through PeerServer. No custom signaling code needed.

5. **Media** — Audio (and optionally video) flows between browsers. With `iceTransportPolicy: 'relay'`, all media routes through coturn. The TURN server relays encrypted packets it cannot read.

6. **E2EE** — After the call connects, the room creator generates an ephemeral AES-256-GCM key, applies frame-level encryption via the Encoded Transform API, and sends the key to the joiner via a PeerJS data connection (over the already-encrypted DTLS channel).

7. **Teardown** — When users hang up, all streams stop, the peer is destroyed, and the room ceases to exist. Nothing is persisted.

## File Structure

```
Telvy/
├── src/
│   ├── pages/
│   │   └── index.astro          Single-page app
│   │                            - Landing: orb button, "tap to start"
│   │                            - Call: room ID, orb (audio-reactive), controls
│   │                            - All states managed client-side
│   │
│   ├── layouts/
│   │   └── Layout.astro         Base HTML layout (Inter font, light theme)
│   │
│   ├── styles/
│   │   └── global.css           Tailwind v4 theme, orb animations, controls
│   │
│   └── lib/
│       ├── call.ts              PeerJS call logic (client-side)
│       │                        - Fetches HMAC TURN credentials
│       │                        - Creates PeerJS peer (room ID = peer ID)
│       │                        - Handles call/answer, stream playback
│       │                        - Audio analyser → orb reactivity
│       │                        - E2EE key exchange via data connection
│       │                        - Safety numbers from DTLS fingerprints
│       │                        - UI controls (mic, video, hang up, copy link)
│       │
│       ├── crypto.ts            Cryptographic primitives (Web Crypto API)
│       │                        - computeVerificationCode() — safety numbers
│       │                        - stripSdp() / shouldDropCandidate()
│       │                        - arrayBufferToBase64() / base64ToArrayBuffer()
│       │
│       ├── e2ee-worker.ts       Web Worker for frame encryption
│       │                        - AES-256-GCM per-frame encrypt/decrypt
│       │                        - Preserves codec headers (10B video, 1B audio)
│       │                        - Counter-based IV (no repeats)
│       │
│       └── room-id.ts           Room ID generator (unique-names-generator)
│
├── server/
│   ├── index.ts                 PeerServer + TURN credentials API
│   │                            - Express + ExpressPeerServer on one port
│   │                            - GET /api/turn-credentials → HMAC creds
│   │                            - Runs on Bun
│   │
│   └── coturn.conf              coturn configuration template
│                                - HMAC auth (use-auth-secret)
│                                - Private network deny rules
│                                - No logging
│
├── public/
│   └── favicon.svg
│
├── docs/
│   └── SECURITY.md              Detailed security documentation
│
├── astro.config.mjs             Static output, Tailwind, dev proxy
├── package.json
└── tsconfig.json
```

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

### Summary

| Layer | What it protects | How |
|-------|-----------------|-----|
| **DTLS-SRTP** | Media transport | Built into WebRTC (always on) |
| **E2EE** | Audio/video content | AES-256-GCM frame encryption via Encoded Transform API |
| **TLS** | Signaling | WSS for PeerServer, TURNS for coturn |
| **TURN relay** | IP addresses | `iceTransportPolicy: 'relay'` hides participant IPs |
| **HMAC credentials** | TURN server abuse | Time-limited, per-session, HMAC-SHA1 validated |
| **Safety numbers** | MITM detection | SHA-256 of DTLS fingerprints → 6-digit verification code |
| **Zero persistence** | Data leaks | No database, no logs, no analytics |

### What the server can see

- That two peers are connected to the same room (PeerServer)
- Both participants' IP addresses (PeerServer and coturn)
- Connection timing and duration
- Encrypted media packets (coturn, cannot decrypt)

### What the server cannot see

- Call content (audio, video)
- What is being said or shown
- DTLS keys or E2EE keys
- SDP content (when encrypted signaling is enabled)

## Configuration

### astro.config.mjs
- `output: 'static'` — Pure static site, no SSR
- `vite.server.proxy` — Dev proxy: `/peerjs` and `/api` → `localhost:9000`
- `vite.plugins` — Tailwind CSS v4

### Environment Variables (server)
- `PEER_PORT` — PeerServer port (default: `9000`)
- `TURN_SECRET` — Shared secret for HMAC TURN credentials (must match coturn.conf)
- `TURN_DOMAIN` — TURN server hostname (default: `localhost`)

## Scripts

```bash
bun run dev          # Astro dev (hot reload, port 4321) + PeerServer (port 9000)
bun run build        # Build static site to dist/
bun run start        # Production PeerServer only
bun run preview      # Build + Astro preview
```

## Production Deployment

Single Swiss VPS running three services:

```
nginx (443, TLS) ──┬── /peerjs/* → PeerServer (9000)
                   ├── /api/*    → PeerServer (9000)
                   └── /*        → static files (dist/)

coturn (3478 UDP/TCP, 5349 TLS) ── STUN/TURN relay
```

### Setup

1. Build: `bun run build`
2. Copy `dist/` to VPS, serve with nginx
3. Run PeerServer: `TURN_SECRET=<secret> TURN_DOMAIN=telvy.ch bun run start`
4. Run coturn: `turnserver -c /path/to/coturn.conf` (set `static-auth-secret` to match `TURN_SECRET`)
5. Configure nginx reverse proxy + TLS (Let's Encrypt)
