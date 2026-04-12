# Frequently Asked Questions

## Architecture

### Why do we still need a signaling server?
Two browsers cannot discover each other without an introduction step. Telvy uses a minimal WebSocket server to relay encrypted SDP and ICE data before the WebRTC session exists.

### Why not remove the signaling server entirely?
Standard WebRTC still needs some rendezvous path. Telvy keeps that path tiny and self-hosted instead of outsourcing it to a third-party relay or tracker.

### Why do we need both STUN and TURN?
STUN lets the browser discover its public-facing address. TURN relays media when direct peer connectivity is blocked. Telvy forces TURN relay for privacy, so both users see only the relay IP.

### Does all media go through our server?
Yes. `iceTransportPolicy: 'relay'` forces audio and video through coturn so peers do not learn each other's IP addresses.

## Privacy & Security

### What does the server actually see?
- the derived `roomTag` used for rendezvous
- both participants' IP addresses
- connection timing
- encrypted signaling payloads
- encrypted TURN traffic

### Does the server see the raw 3-word phrase?
Not directly. Telvy puts the phrase in the URL fragment (`/#phrase`) or accepts it through the local join input. The browser does not send the fragment in HTTP requests, and WebSocket joins use only a derived `roomTag`.

### If the server does not see the raw phrase, why do we still need safety numbers?
Because three ordinary words are still a relatively small secret space. Telvy stretches the phrase client-side with a slow PBKDF2 step to raise the cost of brute-force, but a powerful malicious server could still try to recover short phrases from the derived `roomTag`. Safety numbers detect active interception and should be compared on sensitive calls.

### Can the server decrypt call content?
Not passively without extra work. Telvy never sends the raw phrase to the server, and signaling/media keys are derived client-side. But because the invite is only three words, a malicious server with enough compute could attempt to brute-force the stretched phrase-derived material. Telvy raises that cost; it does not eliminate it.

### Is the signaling encrypted?
Yes. SDP offers/answers and ICE candidates are encrypted client-side with AES-256-GCM before they are relayed over WebSocket.

### How is the room matched if the phrase is not sent?
The browser stretches the phrase locally, derives a deterministic `roomTag`, and sends only that tag to the signaling server. Peers who know the same phrase derive the same `roomTag`.

### Why exactly three words?
It is the simplest share model Telvy can offer. The product intentionally favors memorability and verbal sharing over longer random invite tokens.

### Why use slow phrase stretching?
Without it, the derived `roomTag` would be much cheaper to brute-force. Telvy runs PBKDF2-SHA256 with a high iteration count once at call start, then expands that stretched secret into signaling and media keys.

### What are safety numbers?
A 6-digit code derived from both peers' DTLS fingerprints. If both people see the same code, the DTLS handshake was not actively replaced in transit.

### Does Telvy have forward secrecy?
Not in the Signal-protocol sense. Telvy currently uses a single per-call SFrame key derived from the stretched phrase plus WebRTC's built-in DTLS-SRTP transport security. The design is intentionally simple and does not include an in-call ratchet.

### Why no PIN anymore?
Telvy now optimizes for one invite artifact only: the 3-word phrase. Adding a second manual secret improves security but weakens the product's simplicity goal.

## Product Tradeoffs

### Is Telvy more private than Signal?
Different tradeoffs. Signal has a stronger and more mature protocol. Telvy is simpler to self-host, requires no accounts, and keeps the infrastructure fully under your control. If your main priority is protocol hardness, Signal wins. If your main priority is infrastructure independence and zero-friction browser calls, Telvy is the point.

### Can Telvy hide user IPs?
From each other: yes, because media is forced through TURN. From your own TURN server: no, because someone still has to relay packets.

### Why not add Tor?
WebRTC needs low-latency UDP and Tor does not provide that. Tor Browser also disables WebRTC entirely.

### Why not use a long random token instead of 3 words?
That would be stronger cryptographically, but it would break Telvy's main UX promise: something you can say aloud and remember without copy-paste.

### Should users share the phrase or the link?
Either works. The phrase is the core secret. The link is just a convenience wrapper that puts the phrase in the URL fragment for one-tap join.
