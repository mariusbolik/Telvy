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

1. **Room creation** — User clicks the orb on the landing page. JavaScript generates a 3-word phrase (e.g. `badge-ladder-orbit`) from a vendored 7,776-word list, updates the URL to `/#badge-ladder-orbit`, and prepares the call locally.

2. **TURN credentials** — Before connecting, the client fetches time-limited HMAC credentials from `/api/turn-credentials`. The server generates `username = expiry_timestamp`, `credential = HMAC-SHA1(secret, username)`. These expire after 1 hour. The endpoint is rate-limited to 10 requests per minute per IP.

3. **Key derivation** — The browser stretches the 3-word phrase client-side with Argon2id, then expands that master secret with HKDF into a room tag, encrypted signaling key, and media E2EE key. No key exchange happens over the wire. Both peers independently derive the same material from the same shared phrase.

4. **Joining** — The second user opens the shared link (`/#badge-ladder-orbit`) or types the same phrase. Their client derives the same room tag and connects to the same WebSocket room. The signaling server pairs the two peers.

5. **Signaling** — SDP offers/answers and ICE candidates are encrypted client-side with AES-256-GCM before being sent over WebSocket. The server sees only the derived room tag plus encrypted blobs it cannot read.

6. **Media** — Audio (and optionally video) flows between browsers. With `iceTransportPolicy: 'relay'`, all media routes through coturn. The TURN server relays encrypted packets it cannot read.

7. **E2EE** — Frame-level encryption using SFrame (RFC 9605) via the Encoded Transform API. Uses AES-256-GCM with SFrame header as authenticated data. The media key is derived locally from the Argon2id-stretched phrase and never exchanged over the wire. The same key is used for the full call duration.

8. **Teardown** — When users hang up, all streams stop, the connection is closed, and the room ceases to exist. Nothing is persisted.

## File Structure

```
Telvy/
├── src/
│   ├── pages/
│   │   └── index.astro          Single-page app
│   │                            - Landing: orb button, "tap to start"
│   │                            - Call: 3-word phrase, orb (audio-reactive), controls
│   │                            - All states managed client-side
│   │
│   ├── layouts/
│   │   └── Layout.astro         Base HTML layout
│   │
│   ├── styles/
│   │   └── global.css           Tailwind v4 theme, orb animations, controls
│   │
│   └── lib/
│       ├── call.ts              WebRTC call logic (client-side)
│       │                        - Fetches HMAC TURN credentials
│       │                        - Native RTCPeerConnection (no wrapper)
│       │                        - Encrypted WebSocket signaling (AES-256-GCM)
│       │                        - Argon2id + HKDF key derivation from a 3-word phrase
│       │                        - ICE candidate queuing for reliable relay setup
│       │                        - Audio analyser → orb reactivity
│       │                        - Safety numbers from DTLS fingerprints
│       │                        - UI controls (mic, video, hang up, copy link)
│       │
│       ├── crypto.ts            Cryptographic primitives (Web Crypto API)
│       │                        - Argon2id phrase stretching + HKDF expansion
│       │                        - computeVerificationCode() — safety numbers
│       │                        - arrayBufferToBase64() / base64ToArrayBuffer()
│       │
│       ├── e2ee-worker.ts       SFrame (RFC 9605) frame encryption
│       │                        - AES-256-GCM with SFrame header as AAD
│       │                        - HKDF key derivation per spec (Extract/Expand)
│       │                        - Variable-length SFrame header (KID + CTR)
│       │                        - Nonce = sframe_salt XOR counter
│       │                        - CryptoKey cached per session (not per frame)
│       │
│       ├── room-phrase.ts       3-word phrase generator/parser
│       └── vendor/
│           └── eff-long-wordlist.txt
│
├── server/
│   ├── index.ts                 WebSocket signaling + TURN credentials API
│   │                            - Express + ws (WebSocket) on one port
│   │                            - /ws?roomTag={derivedTag} → encrypted signaling
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
| **E2EE** | Audio/video content | SFrame (RFC 9605) via Encoded Transform API |
| **Encrypted signaling** | SDP/ICE exchange | AES-256-GCM encrypted client-side (key derived from the stretched 3-word phrase) |
| **Session key** | Media content | E2EE key fixed for call lifetime — derived from the stretched 3-word phrase, never sent over wire |
| **TLS** | Transport | WSS for signaling WebSocket, TURNS for coturn |
| **TURN relay** | IP addresses | `iceTransportPolicy: 'relay'` hides participant IPs |
| **HMAC credentials** | TURN server abuse | Time-limited, per-session, HMAC-SHA1 validated |
| **Safety numbers** | MITM detection | SHA-256 of DTLS fingerprints → 6-digit verification code |
| **Zero persistence** | Data leaks | No database, no logs, no analytics |

### What the server can see

- That two peers are connected to the same room (signaling server sees a derived room tag only)
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
- `TURN_SECRET` — Shared secret for HMAC TURN credentials (must match coturn.conf, required)
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

coturn (3478 UDP/TCP, 5349 TLS, 49152-65535 UDP relay) ── STUN/TURN relay
```

### Setup

```bash
bun run build
sudo bash deploy/setup.sh --domain your.domain.com --email admin@your.domain.com
```

The script configures all services. Required open ports: 443/tcp, 3478/tcp+udp, 5349/tcp+udp, **49152–65535/udp** (TURN relay — without this, coturn allocates relay addresses but media packets cannot pass through).
