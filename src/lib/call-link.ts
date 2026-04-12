const SHARE_SECRET_BYTES = 32;
const SHARE_SECRET_PARAM = 's';
const SHARE_SECRET_PATTERN = /^[a-f0-9]{64}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateShareSecret(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(SHARE_SECRET_BYTES)));
}

export function buildShareUrl(origin: string, roomId: string, shareSecret: string): string {
  const fragment = new URLSearchParams({ [SHARE_SECRET_PARAM]: shareSecret }).toString();
  return `${origin}/?room=${encodeURIComponent(roomId)}#${fragment}`;
}

export function parseCallUrl(url: URL): { roomId: string; shareSecret: string } | null {
  const roomId = url.searchParams.get('room');
  const shareSecret = new URLSearchParams(url.hash.slice(1)).get(SHARE_SECRET_PARAM);

  if (!roomId || !shareSecret || !SHARE_SECRET_PATTERN.test(shareSecret)) {
    return null;
  }

  return { roomId, shareSecret };
}
