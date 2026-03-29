# AGENTS.md

Telvy — secure P2P audio/video calls. No signup, no database, no third-party services.

## Project Overview

Browser-based 1:1 calling app. Audio-first, video optional. Single-page Astro static site + encrypted WebSocket signaling server (ws) + coturn for TURN/STUN relay. All self-hosted on a Swiss VPS.

## Tech Stack

- **Astro 6** (static output, no SSR)
- **Native WebRTC + WebSocket signaling (ws)** (encrypted signaling, no wrapper library)
- **coturn** (STUN/TURN relay, HMAC credentials)
- **Tailwind CSS v4** (via Vite plugin)
- **Bun** (runtime, package manager)

## Key Files

- `src/lib/call.ts` — Core call logic: native WebRTC, encrypted WS signaling, HKDF key derivation, audio/video, orb reactivity, E2EE, UI controls
- `src/lib/crypto.ts` — Verification codes (SHA-256 from DTLS fingerprints), base64 utils
- `src/lib/e2ee-worker.ts` — SFrame (RFC 9605) frame encryption with HKDF key ratcheting
- `src/lib/room-id.ts` — Word-based room ID generation (unique-names-generator)
- `src/pages/index.astro` — Single page: all UI states (idle, waiting, connected, disconnected)
- `server/index.ts` — WebSocket signaling server (Express + ws) + TURN credentials API (rate-limited)
- `server/coturn.conf` — coturn configuration template

## Architecture

Room ID used as WebSocket room + HKDF key derivation input.
Signaling messages encrypted client-side (AES-256-GCM, HKDF-SHA256 from room ID + optional PIN).
E2EE key derived from room ID + PIN via HKDF — no key exchange over the wire.
Key ratcheted every 60s (HKDF chain) for forward secrecy.
All media forced through TURN relay (`iceTransportPolicy: 'relay'`).
No external services — zero third-party network requests.

## Commands

- `bun run dev` — Astro hot reload (4321) + signaling server (9000)
- `bun run build` — Static build to dist/
- `bun run start` — Production signaling server only

## Security Constraints

- No external servers (no Google STUN, no CDN, no analytics)
- No logging on signaling server or coturn
- TURN credentials are HMAC-SHA1, 1-hour TTL, rate-limited
- E2EE via SFrame (RFC 9605) with AES-256-GCM and HKDF key ratcheting
- `prefers-reduced-motion` respected
- All controls have ARIA labels

## When Modifying

- Keep zero external network dependencies
- Never add logging that persists peer IDs or IPs
- Never add cookies, localStorage, or tracking
- Test with two browser tabs on `bun run dev`
- System fonts only (no Google Fonts)
