# TODO

## Security Decisions

### E2EE Rekeying

- Keep the current single per-call SFrame key as the default design.
- Do not reintroduce the old timer-based HKDF ratchet. It added complexity in the media path, caused real-time sync problems, and did not provide strong forward secrecy because the full chain remained derivable from the shared invite secret.
- If stronger post-compromise protection is needed later, add an authenticated ephemeral rekey exchange instead of a deterministic ratchet.

### Why Not the Old Ratchet

- The previous ratchet required clock alignment, previous-key fallback, and extra transition logic to avoid audio artifacts.
- Because the ratchet chain was still rooted in the same shared secret, compromise of the room secret could still expose the whole derived chain.
- That tradeoff is wrong for Telvy's goal: minimal, understandable, secure, and reliable 1:1 calls.

### If We Ever Upgrade

- Bootstrap the call with the existing phrase-derived key.
- During the call, generate fresh ephemeral ECDH keypairs on both peers.
- Exchange ephemeral public keys over encrypted signaling.
- Authenticate each rekey message with the current session key and bind it to the current call context.
- Derive the next SFrame key from the ephemeral shared secret via HKDF.
- Switch keys only after an explicit ack, with a brief overlap window for in-flight frames.

### Decision

- Right now: no ratchet.
- Future upgrade path: authenticated ephemeral rekey exchange, only if the extra protocol complexity is justified.
