// Cryptographic utilities — Web Crypto API only, zero external dependencies.

// --- Base64 ---

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(str: string): ArrayBuffer {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// --- HKDF key derivation ---

async function deriveKey(
  input: string,
  salt: string,
  info: string,
): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(salt),
      info: new TextEncoder().encode(info),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

// Derive signaling encryption key from room ID + optional PIN
export function deriveSignalingKey(roomId: string, pin?: string): Promise<CryptoKey> {
  return deriveKey(roomId + (pin || ''), 'telvy-signaling-v1', 'signaling');
}

// Derive E2EE media key from room ID + optional PIN
export function deriveCallKey(roomId: string, pin?: string): Promise<CryptoKey> {
  return deriveKey(roomId + (pin || ''), 'telvy-call-v1', 'e2ee-media');
}

// --- Encrypted signaling ---

export async function encryptSignaling(key: CryptoKey, data: object): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return arrayBufferToBase64(combined.buffer);
}

export async function decryptSignaling(key: CryptoKey, encoded: string): Promise<object> {
  const combined = new Uint8Array(base64ToArrayBuffer(encoded));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// --- Safety numbers ---

function extractFingerprint(sdp: string): string | null {
  const match = sdp.match(/a=fingerprint:sha-256\s+([A-Fa-f0-9:]+)/);
  return match ? match[1] : null;
}

export async function computeVerificationCode(
  localSdp: string,
  remoteSdp: string,
): Promise<string> {
  const localFp = extractFingerprint(localSdp);
  const remoteFp = extractFingerprint(remoteSdp);

  if (!localFp || !remoteFp) return '--- ---';

  const sorted = [localFp, remoteFp].sort();
  const input = new TextEncoder().encode(sorted[0] + '|' + sorted[1]);
  const hash = await crypto.subtle.digest('SHA-256', input);

  const view = new DataView(hash);
  const value = view.getUint32(0, false);
  const code = String(value % 1_000_000).padStart(6, '0');

  return code.slice(0, 3) + ' ' + code.slice(3);
}
