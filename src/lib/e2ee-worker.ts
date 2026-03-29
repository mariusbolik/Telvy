// E2EE Web Worker — AES-256-GCM frame encryption with key ratcheting

let encryptionKey: CryptoKey | null = null;
let currentKeyRaw: ArrayBuffer | null = null;
let frameCounter = 0;

const VIDEO_HEADER = 10;
const AUDIO_HEADER = 1;
const IV_SIZE = 12;
const RATCHET_INTERVAL = 60_000; // 60 seconds

// Counter-based IV (unique per frame)
function counterToIv(counter: number): Uint8Array {
  const iv = new Uint8Array(IV_SIZE);
  const view = new DataView(iv.buffer);
  view.setUint32(4, Math.floor(counter / 0x100000000), false);
  view.setUint32(8, counter >>> 0, false);
  return iv;
}

// HKDF key ratchet — deterministic, both peers derive the same sequence
async function ratchet() {
  if (!currentKeyRaw) return;

  const ikm = await crypto.subtle.importKey('raw', currentKeyRaw, 'HKDF', false, ['deriveBits']);
  currentKeyRaw = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('telvy-ratchet'),
      info: new TextEncoder().encode('next-key'),
    },
    ikm,
    256,
  );

  encryptionKey = await crypto.subtle.importKey(
    'raw',
    currentKeyRaw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

  frameCounter = 0;
}

async function encryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController,
  kind: string,
) {
  if (!encryptionKey) { controller.enqueue(frame); return; }

  const headerSize = kind === 'video' ? VIDEO_HEADER : AUDIO_HEADER;
  const data = new Uint8Array(frame.data);
  if (data.byteLength <= headerSize) { controller.enqueue(frame); return; }

  const header = data.slice(0, headerSize);
  const payload = data.slice(headerSize);
  const iv = counterToIv(frameCounter++);

  try {
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, encryptionKey, payload);
    const out = new Uint8Array(headerSize + IV_SIZE + enc.byteLength);
    out.set(header, 0);
    out.set(iv, headerSize);
    out.set(new Uint8Array(enc), headerSize + IV_SIZE);
    frame.data = out.buffer;
  } catch { /* pass through on error */ }

  controller.enqueue(frame);
}

async function decryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController,
  kind: string,
) {
  if (!encryptionKey) { controller.enqueue(frame); return; }

  const headerSize = kind === 'video' ? VIDEO_HEADER : AUDIO_HEADER;
  const data = new Uint8Array(frame.data);
  if (data.byteLength <= headerSize + IV_SIZE) { controller.enqueue(frame); return; }

  const header = data.slice(0, headerSize);
  const iv = data.slice(headerSize, headerSize + IV_SIZE);
  const ciphertext = data.slice(headerSize + IV_SIZE);

  try {
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, encryptionKey, ciphertext);
    const out = new Uint8Array(headerSize + dec.byteLength);
    out.set(header, 0);
    out.set(new Uint8Array(dec), headerSize);
    frame.data = out.buffer;
  } catch { /* pass through — key mismatch during ratchet transition */ }

  controller.enqueue(frame);
}

// RTCRtpScriptTransform handler
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

// Key setup + ratchet timer
self.addEventListener('message', async (event: MessageEvent) => {
  if (event.data.type === 'setKey') {
    currentKeyRaw = event.data.key;
    encryptionKey = await crypto.subtle.importKey(
      'raw', currentKeyRaw!, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
    );
    frameCounter = 0;

    // Start deterministic ratchet — both peers ratchet at same interval
    setInterval(ratchet, RATCHET_INTERVAL);
  }
});
