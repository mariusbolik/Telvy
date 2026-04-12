import {
  uniqueNamesGenerator,
  adjectives,
  colors,
  animals,
} from 'unique-names-generator';

const ROOM_PHRASE_PATTERN = /^[a-z]+(?:-[a-z]+){2}$/;

export function generateRoomPhrase(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals],
    separator: '-',
    style: 'lowerCase',
  });
}

export function formatRoomPhrase(roomPhrase: string): string {
  return roomPhrase.replace(/-/g, ' ');
}

export function normalizeRoomPhrase(input: string): string | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');

  return ROOM_PHRASE_PATTERN.test(normalized) ? normalized : null;
}

export function buildShareUrl(origin: string, roomPhrase: string): string {
  return `${origin}/#${encodeURIComponent(roomPhrase)}`;
}

export function parseCallUrl(url: URL): string | null {
  const hash = decodeURIComponent(url.hash.slice(1));
  return hash ? normalizeRoomPhrase(hash) : null;
}

export function parseRoomPhraseInput(input: string, origin: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.includes('://') || trimmed.startsWith('/')) {
    try {
      return parseCallUrl(new URL(trimmed, origin));
    } catch {
      return null;
    }
  }

  return normalizeRoomPhrase(trimmed);
}
