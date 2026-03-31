// SFrame (RFC 9605) E2EE Web Worker
// Cipher suite: AES_256_GCM_SHA512_128 (AES-256-GCM, SHA-256, 128-bit tag)
// Single per-call SFrame key derived via HKDF

// RTCTransformEvent is defined in lib.webworker.d.ts but not lib.dom.d.ts.
// Declare the minimal interface needed for this worker.
interface E2eeTransformOptions {
  direction: 'encrypt' | 'decrypt';
  kind: 'audio' | 'video';
}

interface RTCTransformEvent extends Event {
  readonly transformer: {
    readonly options: E2eeTransformOptions;
    readonly readable: ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
    readonly writable: WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
  };
}

let sframeKey: ArrayBuffer | null = null;
let sframeSalt: ArrayBuffer | null = null;
let counter = 0;

// Cached CryptoKey objects — imported once on key derivation, not per frame
let encryptKey: CryptoKey | null = null;
let decryptKey: CryptoKey | null = null;

const VIDEO_HEADER = 10;
const AUDIO_HEADER = 1;

// --- HKDF (RFC 5869) via Web Crypto ---

async function hkdfExtract(salt: BufferSource, ikm: BufferSource): Promise<ArrayBuffer> {
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
  sframeKey = await hkdfExpand(secret, 'key', 32);  // AES-256
  sframeSalt = await hkdfExpand(secret, 'salt', 12); // GCM nonce base

  // Cache CryptoKey objects — avoid re-importing on every frame
  encryptKey = await crypto.subtle.importKey('raw', sframeKey, { name: 'AES-GCM' }, false, ['encrypt']);
  decryptKey = await crypto.subtle.importKey('raw', sframeKey, { name: 'AES-GCM' }, false, ['decrypt']);
}

// --- SFrame header encoding (RFC 9605 Section 4.3) ---

function encodeSFrameHeader(ctr: number): Uint8Array {
  // KID is always 0 (no ratcheting), fits in 3 bits (x=0, k=0)
  const y = ctr < 8 ? 0 : 1;
  const c = ctr < 8 ? ctr : Math.ceil(Math.log2(Math.max(ctr, 1) + 1) / 8) - 1;
  const config = (y << 3) | c;

  if (y === 0) {
    return new Uint8Array([config]);
  }

  const ctrBytes = c + 1;
  const header = new Uint8Array(1 + ctrBytes);
  header[0] = config;
  for (let i = ctrBytes - 1; i >= 0; i--) header[1 + (ctrBytes - 1 - i)] = (ctr >> (i * 8)) & 0xff;
  return header;
}

function decodeSFrameHeader(data: Uint8Array): { kid: number; ctr: number; headerLen: number } {
  const config = data[0];
  const x = (config >> 7) & 1;
  const k = (config >> 4) & 0x7;
  const y = (config >> 3) & 1;
  const c = config & 0x7;

  let offset = 1;
  let kid = 0;
  let ctr = 0;

  if (x === 0) {
    kid = k;
  } else {
    const len = k + 1;
    for (let i = 0; i < len; i++) kid = (kid << 8) | data[offset++];
  }

  if (y === 0) {
    ctr = c;
  } else {
    const len = c + 1;
    for (let i = 0; i < len; i++) ctr = (ctr << 8) | data[offset++];
  }

  return { kid, ctr, headerLen: offset };
}

// --- Nonce construction (RFC 9605 Section 4.4.3) ---

function buildNonce(ctr: number, salt: ArrayBuffer): Uint8Array {
  const nonce = new Uint8Array(new Uint8Array(salt));
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
  controller: TransformStreamDefaultController<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
  kind: 'audio' | 'video',
) {
  if (!encryptKey || !sframeSalt) { controller.enqueue(frame); return; }

  const mediaHeader = kind === 'video' ? VIDEO_HEADER : AUDIO_HEADER;
  const data = new Uint8Array(frame.data);
  if (data.byteLength <= mediaHeader) { controller.enqueue(frame); return; }

  const header = encodeSFrameHeader(counter);
  const nonce = buildNonce(counter, sframeSalt);
  counter++;

  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header },
      encryptKey,
      data.slice(mediaHeader),
    );

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
  controller: TransformStreamDefaultController<RTCEncodedVideoFrame | RTCEncodedAudioFrame>,
  kind: 'audio' | 'video',
) {
  if (!decryptKey || !sframeSalt) { controller.enqueue(frame); return; }

  const mediaHeader = kind === 'video' ? VIDEO_HEADER : AUDIO_HEADER;
  const data = new Uint8Array(frame.data);
  if (data.byteLength <= mediaHeader + 1) { controller.enqueue(frame); return; }

  const sframeData = data.slice(mediaHeader);
  const { ctr, headerLen } = decodeSFrameHeader(sframeData);
  const header = sframeData.slice(0, headerLen);
  const ciphertext = sframeData.slice(headerLen);

  try {
    const nonce = buildNonce(ctr, sframeSalt);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: header },
      decryptKey,
      ciphertext,
    );
    const out = new Uint8Array(mediaHeader + plaintext.byteLength);
    out.set(data.slice(0, mediaHeader), 0);
    out.set(new Uint8Array(plaintext), mediaHeader);
    frame.data = out.buffer;
  } catch { /* wrong key or corrupted — pass through */ }

  controller.enqueue(frame);
}

// --- RTCRtpScriptTransform handler ---

self.addEventListener('rtctransform', ((event: Event) => {
  const rtc = event as RTCTransformEvent;
  const { readable, writable } = rtc.transformer;
  const { direction, kind } = rtc.transformer.options;

  readable.pipeThrough(new TransformStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame, RTCEncodedVideoFrame | RTCEncodedAudioFrame>({
    transform: (frame, ctrl) => direction === 'encrypt'
      ? encryptFrame(frame, ctrl, kind)
      : decryptFrame(frame, ctrl, kind),
  })).pipeTo(writable);
}) as EventListener);

// --- Key setup from main thread ---

self.addEventListener('message', async (event: MessageEvent<{ type: string; key: ArrayBuffer }>) => {
  if (event.data.type === 'setKey') {
    await deriveKeys(event.data.key);
    counter = 0;
  }
});
