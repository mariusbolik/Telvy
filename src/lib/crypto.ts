// Cryptographic utilities — Web Crypto API only, zero external dependencies.

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

// Safety numbers — verification code from DTLS fingerprints

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

  // Sort lexicographically so both peers compute the same order
  const sorted = [localFp, remoteFp].sort();
  const input = new TextEncoder().encode(sorted[0] + '|' + sorted[1]);
  const hash = await crypto.subtle.digest('SHA-256', input);

  const view = new DataView(hash);
  const value = view.getUint32(0, false);
  const code = String(value % 1_000_000).padStart(6, '0');

  return code.slice(0, 3) + ' ' + code.slice(3);
}
