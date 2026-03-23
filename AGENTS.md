# AGENTS.md

Telvy — secure P2P audio/video calls. No signup, no database, no third-party services.

## Project Overview

Browser-based 1:1 calling app. Audio-first, video optional. Single-page Astro static site + PeerServer for signaling + coturn for TURN/STUN relay. All self-hosted on a Swiss VPS.

## Tech Stack

- **Astro 6** (static output, no SSR)
- **PeerJS / PeerServer** (WebRTC signaling)
- **coturn** (STUN/TURN relay, HMAC credentials)
- **Tailwind CSS v4** (via Vite plugin)
- **Bun** (runtime, package manager)

## Key Files

- `src/lib/call.ts` — Core call logic: PeerJS lifecycle, audio/video, orb reactivity, E2EE, UI controls
- `src/lib/crypto.ts` — Verification codes (SHA-256 from DTLS fingerprints), base64 utils
- `src/lib/e2ee-worker.ts` — Web Worker for AES-256-GCM frame encryption (Encoded Transform API)
- `src/lib/room-id.ts` — Word-based room ID generation (unique-names-generator)
- `src/pages/index.astro` — Single page: all UI states (idle, waiting, connected, disconnected)
- `server/index.ts` — PeerServer + TURN credentials API (Express, rate-limited)
- `server/coturn.conf` — coturn configuration template

## Architecture

Room ID = PeerJS peer ID. Creator registers as that ID, joiner calls it.
All media forced through TURN relay (`iceTransportPolicy: 'relay'`).
E2EE key exchanged via PeerJS data connection.
No external services — zero third-party network requests.

## Commands

- `bun run dev` — Astro hot reload (4321) + PeerServer (9000)
- `bun run build` — Static build to dist/
- `bun run start` — Production PeerServer only

## Security Constraints

- No external servers (no Google STUN, no CDN, no analytics)
- No logging on PeerServer or coturn
- TURN credentials are HMAC-SHA1, 1-hour TTL, rate-limited
- E2EE via Encoded Transform API (AES-256-GCM per frame)
- `prefers-reduced-motion` respected
- All controls have ARIA labels

## When Modifying

- Keep zero external network dependencies
- Never add logging that persists peer IDs or IPs
- Never add cookies, localStorage, or tracking
- Test with two browser tabs on `bun run dev`
- System fonts only (no Google Fonts)
