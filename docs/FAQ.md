# Frequently Asked Questions

## Architecture

### Why do we need a signaling server? Can't WebRTC connect directly?
Two browsers can't talk to each other without being introduced first. Before a P2P connection exists, someone has to pass connection details (SDP offers, ICE candidates) between them. Our WebSocket signaling server (using the `ws` package) is that middleman. All signaling messages are encrypted client-side (AES-256-GCM) before transmission — the server relays encrypted blobs it cannot read. Once the call connects, the signaling server is no longer in the media path.

### Why do we need STUN?
STUN tells each browser its public IP address. Browsers only know their local/private IP (e.g. `192.168.1.5`), but to connect across the internet, they need public IPs. STUN is how they discover them. Telvy runs its own STUN via coturn — no external STUN servers.

### Why do we need TURN?
When direct P2P connections fail (strict NATs, firewalls), TURN acts as a relay. With `iceTransportPolicy: 'relay'` enabled, all media is forced through TURN — this hides both participants' IP addresses from each other.

### Even with STUN and TURN, we still need the signaling server?
Yes. They solve different problems:
- **STUN/TURN** = network layer (finding IPs, relaying packets)
- **WebSocket signaling server** = coordination (passing encrypted messages before P2P exists)

Every WebRTC app needs all three. Zoom, Google Meet, Signal — they all have a signaling server.

### Does all video/audio traffic go through our server?
It depends on the TURN configuration:
- `iceTransportPolicy: 'all'` (default WebRTC) → media goes P2P, zero server bandwidth
- `iceTransportPolicy: 'relay'` (Telvy's setting) → all media through coturn, server pays bandwidth

Telvy forces relay for maximum privacy. A 1:1 audio call uses ~100 kbps, video ~1-3 Mbps.

### Can we remove the signaling server entirely?
Not for standard WebRTC. Alternatives like trystero can use Nostr relays or BitTorrent trackers for signaling (no central server), but you lose control over the signaling infrastructure. Our minimal WebSocket server is ~20 lines of relay logic — it only forwards encrypted blobs between peers in the same room.

## Privacy & Security

### Is this more private than Signal?
Different trade-offs. Signal has better cryptography (Double Ratchet, per-message forward secrecy, audited protocol). Telvy now also has forward secrecy (key ratcheted every 60s via HKDF chain) and encrypted signaling, but Signal's protocol is more mature and formally audited. Telvy has better infrastructure independence (no phone number, no US servers, no Google STUN, fully self-hosted). If you fear protocol-level attacks, Signal wins. If you fear server-level surveillance or jurisdiction risk, Telvy wins.

### Can the Signal Protocol be used in Telvy?
The Signal Protocol is open source, but it's designed for asynchronous messaging, not real-time calls. It solves problems Telvy doesn't have (offline delivery, persistent identities, prekey bundles). WebRTC's DTLS-SRTP + our frame-level E2EE is the right approach for live calls.

### What's the best setting against surveillance (e.g. NSA)?
Force TURN relay (`iceTransportPolicy: 'relay'`). Without it, ISP logs show "User A sent packets to User B" — they know who called whom. With relay, both users connect to the Swiss VPS — an observer can't prove A talked to B without server cooperation.

### We stripped IPs from signaling but send them to STUN — isn't that contradictory?
Yes, that was a contradiction in the earlier Cloudflare version. Now all STUN/TURN runs on our own coturn server. No external servers see any IP.

### Can Telvy fully hide user IPs?
From each other: yes, with forced TURN relay. From the TURN server: no — someone has to route the packets. Users who want to hide their IP from the server too can use a VPN.

### Should we add Tor?
No. WebRTC doesn't work over Tor — Tor blocks UDP, and real-time media needs UDP. It would add 300-500ms latency, making calls unusable. Tor Browser disables WebRTC entirely. Users who want Tor-level anonymity can use a VPN instead.

### Would both users using a VPN provide the same security as forced TURN relay?
Almost, but not quite. VPN requires both users to have one, configure it, and trust a VPN provider (a third party that sees all traffic). Forced relay is transparent — users just click a link. VPN + relay together would be maximum privacy.

### What can the server see?
- That two peers are connected to the same room (room ID only)
- Both participants' IP addresses
- Connection timing and duration
- Encrypted signaling blobs (cannot decrypt — AES-256-GCM encrypted client-side)
- Encrypted media packets (cannot decrypt)

### What can the server NOT see?
- Call content (audio, video)
- DTLS keys or E2EE keys
- SDP offers/answers or ICE candidates (encrypted before transmission)
- Room PINs (never sent to server)
- What is being said or shown

### What are room PINs?
An optional authentication layer. When creating a room, you can set a PIN. The PIN is appended to the room ID before HKDF key derivation (`HKDF(roomId + PIN)`), so it affects both the signaling encryption key and the E2EE key. The PIN is **never sent to the server** — it only exists client-side. Without the correct PIN, a user cannot decrypt signaling messages or media frames, even if they know the room URL.

### What is forward secrecy and how does Telvy implement it?
Forward secrecy means that compromising a current encryption key does not expose past communications. Telvy ratchets the E2EE key every 60 seconds using an HKDF chain: the current key is fed into HKDF to derive the next key, and the old key is discarded. If an attacker compromises a key mid-call, they can only decrypt the current 60-second window — not any previous segments.

### How is the E2EE key derived?
The key is derived client-side from the room ID + optional PIN using HKDF-SHA256. Both peers independently compute the same key from the shared URL (and PIN, if set). No key material is ever exchanged over the wire — not even over an encrypted channel. This eliminates key-exchange attacks entirely.

### Is the signaling encrypted?
Yes. All signaling messages (SDP offers/answers, ICE candidates) are encrypted client-side with AES-256-GCM before being sent over WebSocket. The encryption key is derived via HKDF-SHA256 from the room ID + optional PIN. The signaling server only sees encrypted blobs and the room ID (used for routing).

## Technology Choices

### Why native WebRTC instead of PeerJS?
We previously used PeerJS, but moved to native WebRTC (`RTCPeerConnection`) for full control over signaling. Native WebRTC lets us encrypt all signaling messages (SDP offers/answers, ICE candidates) client-side with AES-256-GCM before they reach the server. PeerJS abstracted away signaling, making it impossible to encrypt at that layer. The trade-off is more code, but the security gain is significant — the server now sees only encrypted blobs.

### Why did we move away from Cloudflare?
Multiple issues: asset routing intercepted WebSocket paths, `simple-peer` had Node.js polyfill crashes in the browser, encrypted signaling added complexity, and Cloudflare (a US company) contradicted the Swiss privacy story. A self-hosted VPS is simpler, cheaper, and more private.

### Why did we move away from PeerJS?
PeerJS handled signaling internally, which meant we couldn't encrypt signaling messages before they reached the server. With native WebRTC + our own WebSocket signaling server (using the `ws` package), we encrypt all SDP/ICE data client-side. The server relays encrypted blobs it cannot read. This also enabled HKDF-based key derivation (no key exchange over the wire) and key ratcheting for forward secrecy.

### Can FingerprintJS help?
No. It's a browser fingerprinting/tracking library — the opposite of our privacy goals.

### Would React/Preact help?
Preact (3KB) could clean up DOM manipulation, but the current code is simple enough (~500 lines). Not worth the dependency unless the UI grows significantly.

### Can libp2p help?
Minimal benefit. libp2p is a networking layer — it doesn't do audio/video. It could replace our signaling server, but adds ~200KB+ bundle size and complexity. Our minimal WebSocket server does the same job.

### Can Firecracker (micro-VMs) make it more secure?
Technically yes (each call in its own VM), but overkill. Our server doesn't process call content — it relays encrypted packets. There's nothing to exploit. Firecracker makes sense when the server runs untrusted code (recording, transcription). For packet relay, it's unnecessary ops complexity.

### Can Cap'n Web (capnweb) help?
No. It's an RPC library, not a privacy/encryption tool. It could replace raw WebSocket signaling with typed RPC calls, but that's a developer ergonomics improvement, not a privacy one.

## Comparison

### Is Jitsi more private?
Self-hosted Jitsi is decent, but its SFU (Selective Forwarding Unit) decodes and re-encodes video by default. Telvy's media is E2E encrypted — the server relays packets it can't read. Jitsi also requires 6+ components and ~2-4GB RAM vs Telvy's 2 components and ~50MB.

### What's the most private calling solution available?
For 1:1 calls: Session (onion-routed, no account) or SimpleX (no user IDs at all). Both require app installs. Telvy's niche is zero-friction browser calls — no download, no account, one click.

### What about group calls?
Telvy can't do them. P2P doesn't scale beyond 2 participants. For group calls you need an SFU (LiveKit, Jitsi, MediaSoup). Different architecture, different tool.

## HMAC TURN Credentials

### What are HMAC TURN credentials?
Time-limited, per-session credentials for the TURN server. The server generates `username = expiry_timestamp`, `credential = HMAC-SHA1(secret, username)`. coturn validates the HMAC server-side — no database needed. Credentials expire after 1 hour.

### Why not static TURN credentials?
Static credentials can be leaked and shared. Anyone with the credentials can abuse the TURN server as a free relay proxy. HMAC credentials expire automatically and can't be reused.

### Does this improve privacy?
Not directly for call privacy (media is already encrypted), but it hardens the infrastructure against abuse — preventing unauthorized use of the TURN server.
