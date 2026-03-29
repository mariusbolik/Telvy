# Telvy Architecture

Secure peer-to-peer audio and video calls. No signup, no database, no stored data. Fully self-hosted on a Swiss VPS.

## Tech Stack

- **Astro 6** — Static site generator (HTML/CSS/JS, no SSR)
- **Native WebRTC** — Direct use of RTCPeerConnection (no wrapper library)
- **WebSocket signaling (ws)** — Encrypted signaling server (Express + ws, runs on Bun)
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
     │  2. Encrypted WebSocket signaling (AES-256-GCM)           │
     │         ┌────────────────────┐                           │
     ├────────►│ WS signaling (9000)│◄──────────────────────────┤
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

1. **Room creation** — User clicks the orb on the landing page. JavaScript generates a word-based room ID (e.g. `brave-azure-dolphin`) using `unique-names-generator`, updates the URL to `?room=<id>`, and connects to the WebSocket signaling server at `/ws?room=<id>`.

2. **TURN credentials** — Before connecting, the client fetches time-limited HMAC credentials from `/api/turn-credentials`. The server generates `username = expiry_timestamp`, `credential = HMAC-SHA1(secret, username)`. These expire after 1 hour. The endpoint is rate-limited to 10 requests per minute per IP.

3. **Key derivation** — The E2EE key is derived client-side from the room ID (+ optional PIN) via HKDF-SHA256. No key exchange happens over the wire. Both peers independently derive the same key from the shared room URL.

4. **Joining** — The second user opens the shared link (`?room=brave-azure-dolphin`). Their client connects to the same WebSocket room. The signaling server pairs the two peers.

5. **Signaling** — SDP offers/answers and ICE candidates are encrypted client-side with AES-256-GCM (key derived via HKDF-SHA256 from room ID + optional PIN) before being sent over WebSocket. The server sees only encrypted blobs it cannot read.

6. **Media** — Audio (and optionally video) flows between browsers. With `iceTransportPolicy: 'relay'`, all media routes through coturn. The TURN server relays encrypted packets it cannot read.

7. **E2EE** — Frame-level encryption using AES-256-GCM via the Encoded Transform API. The key is derived from the room ID + optional PIN via HKDF — never exchanged over the wire. The key is ratcheted every 60 seconds via an HKDF chain for forward secrecy.

8. **Teardown** — When users hang up, all streams stop, the connection is closed, and the room ceases to exist. Nothing is persisted.

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
│       ├── call.ts              WebRTC call logic (client-side)
│       │                        - Fetches HMAC TURN credentials
│       │                        - Native RTCPeerConnection (no wrapper)
│       │                        - Encrypted WebSocket signaling (AES-256-GCM)
│       │                        - HKDF key derivation from room ID + PIN
│       │                        - Key ratcheting every 60s (forward secrecy)
│       │                        - Audio analyser → orb reactivity
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
│   ├── index.ts                 WebSocket signaling + TURN credentials API
│   │                            - Express + ws (WebSocket) on one port
│   │                            - /ws?room={roomId} → encrypted signaling
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
| **Encrypted signaling** | SDP/ICE exchange | AES-256-GCM encrypted client-side (HKDF-SHA256 from room ID + PIN) |
| **Forward secrecy** | Past call segments | E2EE key ratcheted every 60s via HKDF chain |
| **Room PINs** | Room authentication | Optional PIN appended to room ID before HKDF — never sent to server |
| **TLS** | Transport | WSS for signaling WebSocket, TURNS for coturn |
| **TURN relay** | IP addresses | `iceTransportPolicy: 'relay'` hides participant IPs |
| **HMAC credentials** | TURN server abuse | Time-limited, per-session, HMAC-SHA1 validated |
| **Safety numbers** | MITM detection | SHA-256 of DTLS fingerprints → 6-digit verification code |
| **Zero persistence** | Data leaks | No database, no logs, no analytics |

### What the server can see

- That two peers are connected to the same room (signaling server sees room ID only)
- Both participants' IP addresses (signaling server and coturn)
- Connection timing and duration
- Encrypted signaling blobs (cannot decrypt — AES-256-GCM encrypted client-side)
- Encrypted media packets (coturn, cannot decrypt)

### What the server cannot see

- Call content (audio, video)
- What is being said or shown
- DTLS keys or E2EE keys
- SDP content (when encrypted signaling is enabled)

## Configuration

### astro.config.mjs
- `output: 'static'` — Pure static site, no SSR
- `vite.server.proxy` — Dev proxy: `/ws` and `/api` → `localhost:9000`
- `vite.plugins` — Tailwind CSS v4

### Environment Variables (server)
- `PORT` — Signaling server port (default: `9000`)
- `TURN_SECRET` — Shared secret for HMAC TURN credentials (must match coturn.conf)
- `TURN_DOMAIN` — TURN server hostname (default: `localhost`)

## Scripts

```bash
bun run dev          # Astro dev (hot reload, port 4321) + signaling server (port 9000)
bun run build        # Build static site to dist/
bun run start        # Production signaling server only
bun run preview      # Build + Astro preview
```

## Production Deployment

Single Swiss VPS running three services:

```
nginx (443, TLS) ──┬── /ws       → signaling server (9000, WebSocket)
                   ├── /api/*    → signaling server (9000)
                   └── /*        → static files (dist/)

coturn (3478 UDP/TCP, 5349 TLS) ── STUN/TURN relay
```

### Setup

1. Build: `bun run build`
2. Copy `dist/` to VPS, serve with nginx
3. Run signaling server: `TURN_SECRET=<secret> TURN_DOMAIN=telvy.ch bun run start`
4. Run coturn: `turnserver -c /path/to/coturn.conf` (set `static-auth-secret` to match `TURN_SECRET`)
5. Configure nginx reverse proxy + TLS (Let's Encrypt)
