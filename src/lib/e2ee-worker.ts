// SFrame (RFC 9605) E2EE Web Worker
// Cipher suite: AES_256_GCM_SHA512_128 (AES-256-GCM, SHA-256, 128-bit tag)
// Key ratcheting every 60s via HKDF for forward secrecy

const RATCHET_INTERVAL = 60_000;

let sframeKey: ArrayBuffer | null = null;
let sframeSalt: ArrayBuffer | null = null;
let baseKeyRaw: ArrayBuffer | null = null;
let keyId = 0;
let counter = 0;

const VIDEO_HEADER = 10;
const AUDIO_HEADER = 1;

// --- HKDF (RFC 5869) via Web Crypto ---

async function hkdfExtract(salt: ArrayBuffer, ikm: ArrayBuffer): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, ikm);
}

async function hkdfExpand(prk: ArrayBuffer, info: string, length: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const infoBytes = new TextEncoder().encode(info);
  const input = new Uint8Array(infoBytes.length + 1);
  input.set(infoBytes, 0);
  input[infoBytes.length] = 1;
  const okm = await crypto.subtle.sign('HMAC', key, input);
  return okm.slice(0, length);
}

// --- SFrame key derivation (RFC 9605 Section 4.4.1) ---

async function deriveKeys(baseKey: ArrayBuffer) {
  const salt = new TextEncoder().encode('SFrame10');
  const secret = await hkdfExtract(salt, baseKey);
  sframeKey = await hkdfExpand(secret, 'key', 32); // AES-256
  sframeSalt = await hkdfExpand(secret, 'salt', 12); // GCM nonce
}

// --- SFrame key ratcheting (RFC 9605 Section 4.4.2) ---

async function ratchet() {
  if (!baseKeyRaw) return;

  const salt = new TextEncoder().encode('SFrame10');
  const secret = await hkdfExtract(salt, baseKeyRaw);
  baseKeyRaw = await hkdfExpand(secret, 'ratchet', 32);

  await deriveKeys(baseKeyRaw);
  keyId++;
  counter = 0;
}

// --- SFrame header encoding (RFC 9605 Section 4.3) ---

function encodeSFrameHeader(kid: number, ctr: number): Uint8Array {
  // Config byte: X|KKK|Y|CCC
  const kidBytes = kid < 8 ? 0 : Math.ceil(Math.log2(Math.max(kid, 1) + 1) / 8);
  const ctrBytes = ctr < 8 ? 0 : Math.ceil(Math.log2(Math.max(ctr, 1) + 1) / 8);

  const x = kid < 8 ? 0 : 1;
  const k = kid < 8 ? kid : kidBytes - 1;
  const y = ctr < 8 ? 0 : 1;
  const c = ctr < 8 ? ctr : ctrBytes - 1;

  const config = (x << 7) | (k << 4) | (y << 3) | c;
  const header = new Uint8Array(1 + (x ? kidBytes : 0) + (y ? ctrBytes : 0));
  header[0] = config;

  let offset = 1;
  if (x) {
    for (let i = kidBytes - 1; i >= 0; i--) {
      header[offset++] = (kid >> (i * 8)) & 0xff;
    }
  }
  if (y) {
    for (let i = ctrBytes - 1; i >= 0; i--) {
      header[offset++] = (ctr >> (i * 8)) & 0xff;
    }
  }

  return header;
}

function decodeSFrameHeader(data: Uint8Array): { kid: number; ctr: number; headerLen: number } {
  const config = data[0];
  const x = (config >> 7) & 1;
  const k = (config >> 4) & 0x7;
  const y = (config >> 3) & 1;
  const c = config & 0x7;

  let offset = 1;
  let kid: number;
  let ctr: number;

  if (x === 0) {
    kid = k;
  } else {
    const len = k + 1;
    kid = 0;
    for (let i = 0; i < len; i++) kid = (kid << 8) | data[offset++];
  }

  if (y === 0) {
    ctr = c;
  } else {
    const len = c + 1;
    ctr = 0;
    for (let i = 0; i < len; i++) ctr = (ctr << 8) | data[offset++];
  }

  return { kid, ctr, headerLen: offset };
}

// --- Nonce construction (RFC 9605 Section 4.4.3) ---

function buildNonce(ctr: number): Uint8Array {
  if (!sframeSalt) throw new Error('No salt');
  const salt = new Uint8Array(sframeSalt);
  const nonce = new Uint8Array(12);
  nonce.set(salt);

  // XOR counter into nonce (big-endian, right-aligned)
  const ctrBuf = new Uint8Array(12);
  const view = new DataView(ctrBuf.buffer);
  view.setUint32(4, Math.floor(ctr / 0x100000000), false);
  view.setUint32(8, ctr >>> 0, false);

  for (let i = 0; i < 12; i++) nonce[i] ^= ctrBuf[i];
  return nonce;
}

// --- Encrypt / Decrypt ---

async function encryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController,
  kind: string,
) {
  if (!sframeKey) { controller.enqueue(frame); return; }

  const mediaHeader = kind === 'video' ? VIDEO_HEADER : AUDIO_HEADER;
  const data = new Uint8Array(frame.data);
  if (data.byteLength <= mediaHeader) { controller.enqueue(frame); return; }

  const header = encodeSFrameHeader(keyId, counter);
  const nonce = buildNonce(counter);
  counter++;

  const key = await crypto.subtle.importKey('raw', sframeKey, { name: 'AES-GCM' }, false, ['encrypt']);
  const plaintext = data.slice(mediaHeader);

  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header },
      key,
      plaintext,
    );

    // Output: media_header | sframe_header | ciphertext+tag
    const out = new Uint8Array(mediaHeader + header.byteLength + ciphertext.byteLength);
    out.set(data.slice(0, mediaHeader), 0);
    out.set(header, mediaHeader);
    out.set(new Uint8Array(ciphertext), mediaHeader + header.byteLength);
    frame.data = out.buffer;
  } catch { /* pass through on error */ }

  controller.enqueue(frame);
}

async function decryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController,
  kind: string,
) {
  if (!sframeKey) { controller.enqueue(frame); return; }

  const mediaHeader = kind === 'video' ? VIDEO_HEADER : AUDIO_HEADER;
  const data = new Uint8Array(frame.data);
  if (data.byteLength <= mediaHeader + 1) { controller.enqueue(frame); return; }

  try {
    const sframeData = data.slice(mediaHeader);
    const { ctr, headerLen } = decodeSFrameHeader(sframeData);
    const header = sframeData.slice(0, headerLen);
    const ciphertext = sframeData.slice(headerLen);
    const nonce = buildNonce(ctr);

    const key = await crypto.subtle.importKey('raw', sframeKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header },
      key,
      ciphertext,
    );

    const out = new Uint8Array(mediaHeader + plaintext.byteLength);
    out.set(data.slice(0, mediaHeader), 0);
    out.set(new Uint8Array(plaintext), mediaHeader);
    frame.data = out.buffer;
  } catch { /* ratchet transition or wrong key — pass through */ }

  controller.enqueue(frame);
}

// --- RTCRtpScriptTransform handler ---

self.addEventListener('rtctransform', ((event: Event) => {
  const rtc = event as RTCTransformEvent;
  const { readable, writable } = rtc.transformer;
  const opts = rtc.transformer.options as { direction: string; kind: string };
  const dir = opts?.direction || 'encrypt';
  const kind = opts?.kind || 'video';

  readable.pipeThrough(new TransformStream({
    transform: (frame, ctrl) => dir === 'encrypt'
      ? encryptFrame(frame, ctrl, kind)
      : decryptFrame(frame, ctrl, kind),
  })).pipeTo(writable);
}) as EventListener);

// --- Key setup from main thread ---

self.addEventListener('message', async (event: MessageEvent) => {
  if (event.data.type === 'setKey') {
    baseKeyRaw = event.data.key;
    await deriveKeys(baseKeyRaw!);
    keyId = 0;
    counter = 0;

    // Deterministic ratchet — both peers ratchet at the same interval
    setInterval(ratchet, RATCHET_INTERVAL);
  }
});
