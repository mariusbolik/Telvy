// Web Worker for frame-level AES-256-GCM encryption/decryption
// Used with the WebRTC Encoded Transform API (RTCRtpScriptTransform)

let encryptionKey: CryptoKey | null = null;
let frameCounter = 0;

// Header bytes to preserve unencrypted (browser needs these for packetization)
const VIDEO_HEADER_SIZE = 10;
const AUDIO_HEADER_SIZE = 1;
const IV_SIZE = 12;

function counterToIv(counter: number): Uint8Array {
  const iv = new Uint8Array(IV_SIZE);
  const view = new DataView(iv.buffer);
  // Write counter as big-endian 64-bit integer in the last 8 bytes
  view.setUint32(4, Math.floor(counter / 0x100000000), false);
  view.setUint32(8, counter >>> 0, false);
  return iv;
}

async function encryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController,
  kind: string,
) {
  if (!encryptionKey) {
    controller.enqueue(frame);
    return;
  }

  const headerSize = kind === 'video' ? VIDEO_HEADER_SIZE : AUDIO_HEADER_SIZE;
  const data = new Uint8Array(frame.data);

  if (data.byteLength <= headerSize) {
    controller.enqueue(frame);
    return;
  }

  const header = data.slice(0, headerSize);
  const payload = data.slice(headerSize);
  const iv = counterToIv(frameCounter++);

  try {
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      payload,
    );

    // Output: header || iv(12B) || ciphertext+tag
    const output = new Uint8Array(header.byteLength + IV_SIZE + encrypted.byteLength);
    output.set(header, 0);
    output.set(iv, header.byteLength);
    output.set(new Uint8Array(encrypted), header.byteLength + IV_SIZE);

    frame.data = output.buffer;
    controller.enqueue(frame);
  } catch {
    // On error, pass frame through unencrypted
    controller.enqueue(frame);
  }
}

async function decryptFrame(
  frame: RTCEncodedVideoFrame | RTCEncodedAudioFrame,
  controller: TransformStreamDefaultController,
  kind: string,
) {
  if (!encryptionKey) {
    controller.enqueue(frame);
    return;
  }

  const headerSize = kind === 'video' ? VIDEO_HEADER_SIZE : AUDIO_HEADER_SIZE;
  const data = new Uint8Array(frame.data);

  if (data.byteLength <= headerSize + IV_SIZE) {
    controller.enqueue(frame);
    return;
  }

  const header = data.slice(0, headerSize);
  const iv = data.slice(headerSize, headerSize + IV_SIZE);
  const ciphertext = data.slice(headerSize + IV_SIZE);

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      ciphertext,
    );

    // Reconstruct: header || plaintext
    const output = new Uint8Array(header.byteLength + decrypted.byteLength);
    output.set(header, 0);
    output.set(new Uint8Array(decrypted), header.byteLength);

    frame.data = output.buffer;
    controller.enqueue(frame);
  } catch {
    // Decryption failed — frame might not be encrypted yet (key exchange in progress)
    controller.enqueue(frame);
  }
}

// Handle RTCRtpScriptTransform events
self.addEventListener('rtctransform', ((event: Event) => {
  const rtcEvent = event as RTCTransformEvent;
  const { readable, writable } = rtcEvent.transformer;
  const options = rtcEvent.transformer.options as { direction: string; kind: string };
  const direction = options?.direction || 'encrypt';
  const kind = options?.kind || 'video';

  const transform = new TransformStream({
    transform(frame, controller) {
      if (direction === 'encrypt') {
        return encryptFrame(frame, controller, kind);
      } else {
        return decryptFrame(frame, controller, kind);
      }
    },
  });

  readable.pipeThrough(transform).pipeTo(writable);
}) as EventListener);

// Handle key updates from main thread
self.addEventListener('message', async (event: MessageEvent) => {
  if (event.data.type === 'setKey') {
    encryptionKey = await crypto.subtle.importKey(
      'raw',
      event.data.key,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    frameCounter = 0;
  }
});
