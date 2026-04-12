# Security Model

Telvy is optimized for one goal: the simplest possible 1:1 call flow that still keeps the raw secret client-side.

The user-facing invite is exactly one 3-word phrase. That phrase is never sent to the server directly. Instead, the browser stretches it locally with Argon2id and derives:

- a `roomTag` used for rendezvous on the signaling server
- an AES-GCM signaling key
- an AES-GCM media key used by the SFrame worker

This keeps the UX extremely simple, but it also creates an unavoidable tradeoff: three ordinary words do not carry the same entropy as a long random token. Telvy now uses a much larger 7,776-word curated list plus a memory-hard KDF to raise the brute-force cost materially, but for sensitive calls users should still compare the safety number after connecting.

## Threat Model

**Protected against:**
- Passive network interception of signaling and media
- The signaling server learning the raw 3-word phrase directly from the URL or WebSocket join
- Participants discovering each other's IP addresses
- Plaintext peer-control spoofing over the relay
- TURN credential farming and simple room-join abuse
- Data persistence after the call ends
- Third-party tracking or external service leakage

**Not fully protected against:**
- A malicious server operator with enough compute to brute-force a short phrase from the derived `roomTag`
- A compromised client device
- Denial of service against the VPS or relay
- A compromised VPS modifying the served JavaScript

## Invite and Key Derivation

### 3-word phrase
- A new call generates a phrase like `badge-ladder-orbit`
- The share URL is `/#badge-ladder-orbit`
- The browser does not send the fragment to the server in HTTP requests
- Users can also join by manually typing the same phrase
- New phrases are drawn from a local vendored EFF long wordlist with 7,776 curated words
- Generated phrases never repeat a word

### Memory-hard phrase stretching
- Telvy runs Argon2id client-side with a fixed app salt
- Default parameters are `memorySize = 32768`, `passes = 3`, `parallelism = 1`
- Stretching happens once at call start, then HKDF expands the stretched secret into purpose-specific material

### Derived values
- `roomTag` is sent to `/ws` for rendezvous
- signaling key encrypts SDP offers/answers and ICE candidates before relay
- media key is exported to the SFrame worker for frame-level encryption

The server sees only the derived `roomTag` plus encrypted signaling blobs. It does not receive the raw phrase unless the user types it into some other app or channel outside Telvy.

## Encryption Layers

### Layer 1: DTLS-SRTP
- Standard WebRTC transport encryption between browsers
- Always active
- Protects media on the wire even without SFrame support

### Layer 2: Encrypted signaling
- SDP offers/answers and ICE candidates are encrypted with AES-256-GCM before they reach the signaling server
- The signaling server relays opaque payloads inside a server-only envelope
- Peer-originated plaintext control messages are ignored

### Layer 3: SFrame media encryption
- Audio and video frames are additionally encrypted with AES-256-GCM in the worker
- Key material is derived locally from the stretched phrase
- Browsers without `RTCRtpScriptTransform` fall back to DTLS-SRTP only

## Safety Numbers

The safety number is derived from the DTLS fingerprints in local and remote SDP:

1. Extract both `a=fingerprint:sha-256` values
2. Sort them deterministically
3. Hash the concatenated pair with SHA-256
4. Display a 6-digit code derived from the first 4 bytes

Matching codes confirm that the DTLS handshake was not actively intercepted. For sensitive calls, users should compare the displayed code aloud before talking.

Important: safety numbers detect active interception. They do not make a weak invite phrase high-entropy. That is why Telvy also uses a larger curated wordlist, memory-hard phrase stretching, and keeps the raw phrase out of server-visible URLs.

## Signaling Server Privacy

The signaling server learns:
- that two peers matched on the same derived `roomTag`
- both participants' IP addresses
- connection timing
- encrypted signaling payloads

The signaling server does not learn:
- the raw 3-word phrase directly from the URL or WebSocket join
- plaintext SDP or ICE candidates
- call content in plaintext

## TURN and IP Privacy

Telvy forces `iceTransportPolicy: 'relay'`:

- neither participant sees the other's IP address
- media flows through your TURN server
- TURN sees IP addresses but not plaintext media
- direct peer-to-peer candidates are not used

TURN credentials are minted with HMAC-SHA1 and short TTLs through `/api/turn-credentials`.

## Abuse Controls

- TURN credentials are rate-limited per IP
- WebSocket join attempts are rate-limited per IP and per `roomTag`
- Rooms are capped at 2 peers
- Room state is deleted as soon as the last peer disconnects

## Zero Persistence

- signaling rooms exist only in memory
- rate-limit state exists only in memory
- no database
- no cookies or localStorage
- no analytics
- coturn should be configured without persistent logging

## Production Hardening Checklist

- [ ] Set `TURN_SECRET` to a strong random value
- [ ] Keep `TURN_SECRET` aligned with coturn `static-auth-secret`
- [ ] Enable TLS for nginx and coturn
- [ ] Keep `iceTransportPolicy: 'relay'` enabled
- [ ] Run signaling and coturn as non-root services
- [ ] Restrict firewall ports to HTTPS and TURN
- [ ] Audit the deployed static bundle
- [ ] Treat the safety number as mandatory for sensitive calls
