# Security Model

Telvy is designed so that no party — including the server operator — can access call content.

## Threat Model

**Protected against:**
- Server operator reading call content (E2EE)
- Participants discovering each other's IP addresses (TURN relay)
- Third parties intercepting media (DTLS-SRTP + E2EE)
- Man-in-the-middle attacks on signaling (safety numbers)
- TURN server abuse (HMAC credentials, 1-hour TTL, rate limiting)
- Relay to private networks (coturn deny rules)
- Credential endpoint abuse (10 req/min per IP rate limit)
- Data leaks after call ends (zero persistence)
- External tracking (no third-party services, no CDN, no analytics)

**Not protected against:**
- A compromised client device (screen recording, keyloggers)
- Denial of service against the server infrastructure
- Traffic analysis (an observer can see that a connection exists, but not its content)
- A compromised VPS (the server operator could theoretically modify the served JavaScript)

## Encryption Layers

### Layer 1: DTLS-SRTP (WebRTC built-in)
- Negotiated end-to-end between browsers during the WebRTC handshake
- Encrypts all media packets on the wire
- Keys are never exposed to the server
- Always active — cannot be disabled

### Layer 2: Encrypted Signaling (AES-256-GCM)
- All signaling messages (SDP offers/answers, ICE candidates) are encrypted client-side before transmission
- Encryption key derived via HKDF-SHA256 from room ID + optional PIN
- The signaling server sees only encrypted blobs — it cannot read SDP or ICE data
- Prevents the server operator from learning session descriptions or network topology

### Layer 3: SFrame (RFC 9605)
- Frame-level encryption per the IETF Secure Frame standard (RFC 9605)
- AES-256-GCM with SFrame header as Additional Authenticated Data (AAD)
- Key derived via HKDF: `Extract('SFrame10', base_key)` → `Expand(secret, 'key')` + `Expand(secret, 'salt')`
- Base key derived from room ID + optional PIN — never exchanged over the wire
- Nonce constructed as `sframe_salt XOR counter` (per spec Section 4.4.3)
- Variable-length SFrame header encodes Key ID (KID) and frame counter (CTR)
- Single key for the full call duration — derived once from room ID + PIN, never changes
- Preserves codec headers for browser packetization (10 bytes video, 1 byte audio)
- Graceful degradation: disabled on browsers without `RTCRtpScriptTransform` support

### Layer 4: TLS (Transport)
- All signaling between client and server travels over WSS (WebSocket Secure)
- TURN media relay uses TLS on port 5349 (TURNS)

## No External Services

All infrastructure is self-hosted. Zero third-party network requests:

| Component | Location | Purpose |
|-----------|----------|---------|
| WebSocket signaling server (ws) | Swiss VPS | Encrypted WebRTC signaling |
| coturn STUN | Swiss VPS | Public IP discovery |
| coturn TURN | Swiss VPS | Media relay |
| Static assets | Swiss VPS (nginx) | Frontend files |

No Google STUN, no Cloudflare, no CDN, no external fonts, no analytics, no tracking pixels. The browser makes no network requests to any domain other than your VPS.

## TURN Server Security

### HMAC Credentials
- Credentials are generated per-session via `/api/turn-credentials`
- Format: `username = expiry_timestamp`, `credential = HMAC-SHA1(secret, username)`
- TTL: 1 hour (configurable via `TURN_TTL`)
- coturn validates the HMAC server-side — no database lookup
- The shared secret (`TURN_SECRET`) never reaches the client
- Expired credentials are rejected automatically by coturn

### Rate Limiting
- The `/api/turn-credentials` endpoint is rate-limited to 10 requests per minute per IP
- Exceeding the limit returns HTTP 429 (Too Many Requests)
- Rate limit state is in-memory, resets automatically
- Prevents credential farming and denial-of-service on the credential endpoint

### Network Restrictions
coturn is configured to deny relay to all private/reserved IP ranges:
- `0.0.0.0/8` (current network)
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC 1918 private)
- `100.64.0.0/10` (CGNAT)
- `127.0.0.0/8` (loopback)
- `169.254.0.0/16` (link-local)
- `192.0.0.0/24` (IETF protocol)
- `240.0.0.0/4` (reserved)

This prevents the TURN server from being used as a proxy to scan or access internal networks.

## IP Address Privacy

All media is forced through the TURN server via `iceTransportPolicy: 'relay'` (enabled by default):

- Neither participant learns the other's IP address
- No ICE host or server-reflexive candidates are generated
- The only IP visible to the peer is the TURN server's address
- The TURN server sees both participants' IPs but cannot read the encrypted media
- Direct P2P connections are never attempted

## Session Key

The E2EE key is derived once at call start from the room ID + optional PIN via HKDF-SHA256 and remains fixed for the entire call duration. It is never transmitted over the wire — both peers independently derive the same key from the shared room URL. If the room link is compromised, call content can be decrypted; using a PIN raises the bar significantly.

## Room PINs

Optional room PINs provide an additional authentication layer:

- Users can set a PIN when creating a room
- The PIN is appended to the room ID before HKDF key derivation: `HKDF(roomId + PIN)`
- The PIN is **never sent to the server** — it only exists client-side
- A user who knows the room URL but not the PIN cannot derive the correct encryption key
- Without the correct key, signaling messages cannot be decrypted, and E2EE frames are unreadable
- PINs protect against link-sharing attacks (e.g., a room URL leaked in chat history)

## Safety Numbers (Key Verification)

After a call connects, both participants see a 6-digit verification code derived from:

1. Extract DTLS fingerprints (`a=fingerprint:sha-256`) from both local and remote SDP
2. Sort fingerprints lexicographically (so both peers compute the same order)
3. SHA-256 hash of the concatenated fingerprints
4. First 4 bytes interpreted as a big-endian uint32, modulo 1,000,000
5. Displayed as `XXX XXX`

If both participants see the same code, no MITM attack modified the DTLS handshake. Participants can verify by reading the code aloud.

## Zero Persistence

- **Signaling server**: In-memory only. No database, no file storage, no logging
- **coturn**: `no-stdout-log` and `no-syslog` — no connection logs written
- **Frontend**: Static files. No cookies, no localStorage, no analytics
- **Room state**: Exists only while peers are connected. When the last peer disconnects, the room ceases to exist
- **Rate limit state**: In-memory only, entries expire automatically after 1 minute

## Accessibility

- Orb button has `aria-label` for screen readers
- All controls have `title` attributes
- `prefers-reduced-motion` is respected — all animations disabled for users who request it

## Production Hardening Checklist

- [ ] Set `TURN_SECRET` to a cryptographically random 64+ character string
- [ ] Ensure `TURN_SECRET` matches `static-auth-secret` in coturn.conf
- [ ] Enable TLS on coturn (`cert` and `pkey` in coturn.conf)
- [ ] Set `external-ip` in coturn.conf to your VPS public IP
- [ ] Use nginx with TLS (Let's Encrypt) in front of the signaling server
- [ ] Configure nginx WebSocket proxying for `/ws` endpoint
- [x] Enable `iceTransportPolicy: 'relay'` in call.ts for full IP hiding
- [ ] Run coturn and signaling server as non-root systemd services
- [ ] Enable firewall: only allow ports 443 (HTTPS), 3478 (TURN), 5349 (TURNS)
- [ ] Regularly rotate `TURN_SECRET` (update both coturn.conf and `TURN_SECRET` env var)
- [ ] Audit the static build output — ensure no secrets are embedded in client JS
- [ ] Set `NODE_ENV=production` to disable Express debug output
- [ ] Consider adding `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options` headers in nginx
