// Cryptographic utilities — Web Crypto API plus a local Argon2id Wasm module.

import { loadArgon2id, type computeHash } from './argon2id';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MASTER_KEY_SALT = textEncoder.encode('telvy-master-v2');
const ROOM_TAG_SALT = textEncoder.encode('telvy-room-tag-v2');
const SIGNALING_SALT = textEncoder.encode('telvy-signaling-v2');
const CALL_KEY_SALT = textEncoder.encode('telvy-call-v2');
const ROOM_TAG_INFO = textEncoder.encode('room-tag');
const SIGNALING_INFO = textEncoder.encode('signaling');
const CALL_KEY_INFO = textEncoder.encode('e2ee-media');
const ARGON2ID_MEMORY_SIZE = 2 ** 15;
const ARGON2ID_PASSES = 3;
const ARGON2ID_PARALLELISM = 1;
const ARGON2ID_TAG_LENGTH = 32;
let argon2idLoader: Promise<computeHash> | null = null;

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

async function getArgon2id(): Promise<computeHash> {
  argon2idLoader ??= loadArgon2id();
  return argon2idLoader;
}

async function deriveMasterKey(roomPhrase: string): Promise<CryptoKey> {
  const argon2id = await getArgon2id();
  const password = textEncoder.encode(roomPhrase);

  try {
    const masterSecret = argon2id({
      password,
      salt: MASTER_KEY_SALT,
      parallelism: ARGON2ID_PARALLELISM,
      passes: ARGON2ID_PASSES,
      memorySize: ARGON2ID_MEMORY_SIZE,
      tagLength: ARGON2ID_TAG_LENGTH,
    });

    try {
      return await crypto.subtle.importKey(
        'raw',
        masterSecret,
        'HKDF',
        false,
        ['deriveBits', 'deriveKey'],
      );
    } finally {
      masterSecret.fill(0);
    }
  } finally {
    password.fill(0);
  }
}

async function deriveAesKey(
  masterKey: CryptoKey,
  salt: BufferSource,
  info: BufferSource,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info,
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
      salt: ROOM_TAG_SALT,
      info: ROOM_TAG_INFO,
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
    deriveAesKey(masterKey, SIGNALING_SALT, SIGNALING_INFO),
    deriveAesKey(masterKey, CALL_KEY_SALT, CALL_KEY_INFO),
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
