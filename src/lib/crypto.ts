// Cryptographic utilities — Web Crypto API only, zero external dependencies.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MASTER_KEY_SALT = 'telvy-master-v1';
const MASTER_KEY_ITERATIONS = 750_000;

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

function arrayBufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// --- Slow phrase derivation ---

async function deriveMasterKey(roomPhrase: string): Promise<CryptoKey> {
  const phraseKey = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(roomPhrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const masterSecret = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: textEncoder.encode(MASTER_KEY_SALT),
      iterations: MASTER_KEY_ITERATIONS,
    },
    phraseKey,
    256,
  );

  return crypto.subtle.importKey(
    'raw',
    masterSecret,
    'HKDF',
    false,
    ['deriveBits', 'deriveKey'],
  );
}

async function deriveAesKey(
  masterKey: CryptoKey,
  salt: string,
  info: string,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode(salt),
      info: textEncoder.encode(info),
    },
    masterKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function deriveRoomTag(masterKey: CryptoKey): Promise<string> {
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode('telvy-room-tag-v1'),
      info: textEncoder.encode('room-tag'),
    },
    masterKey,
    256,
  );

  return arrayBufferToHex(bits);
}

export async function deriveCallSecrets(roomPhrase: string): Promise<{
  roomTag: string;
  signalingKey: CryptoKey;
  callKey: CryptoKey;
}> {
  const masterKey = await deriveMasterKey(roomPhrase);
  const [roomTag, signalingKey, callKey] = await Promise.all([
    deriveRoomTag(masterKey),
    deriveAesKey(masterKey, 'telvy-signaling-v1', 'signaling'),
    deriveAesKey(masterKey, 'telvy-call-v1', 'e2ee-media'),
  ]);

  return { roomTag, signalingKey, callKey };
}

// --- Encrypted signaling ---

export async function encryptSignaling(key: CryptoKey, data: object): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return arrayBufferToBase64(combined.buffer);
}

export async function decryptSignaling(key: CryptoKey, encoded: string): Promise<unknown> {
  const combined = new Uint8Array(base64ToArrayBuffer(encoded));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(textDecoder.decode(plaintext));
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
  const input = textEncoder.encode(sorted[0] + '|' + sorted[1]);
  const hash = await crypto.subtle.digest('SHA-256', input);

  const view = new DataView(hash);
  const value = view.getUint32(0, false);
  const code = String(value % 1_000_000).padStart(6, '0');

  return code.slice(0, 3) + ' ' + code.slice(3);
}
