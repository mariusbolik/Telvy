import effLongWordlistText from './vendor/eff-long-wordlist.txt?raw';

const ROOM_PHRASE_WORD_COUNT = 3;
const ROOM_WORD_PATTERN = /^[a-z]+$/;
const ROOM_WORDLIST = effLongWordlistText
  .trim()
  .split(/\r?\n/)
  .map((word) => word.trim())
  .filter(Boolean);
const ROOM_WORD_SET = new Set(ROOM_WORDLIST);

if (ROOM_WORDLIST.length !== 7_776) {
  throw new Error(`Expected 7776 room words, got ${ROOM_WORDLIST.length}.`);
}

if (ROOM_WORD_SET.size !== ROOM_WORDLIST.length) {
  throw new Error('Room wordlist contains duplicates.');
}

export type RoomPhraseError = 'incomplete' | 'invalid-format' | 'unknown-word';

type RoomPhraseParseResult = {
  roomPhrase: string | null;
  error: RoomPhraseError | null;
};

function getRandomIndex(limit: number): number {
  const randomValue = new Uint32Array(1);
  const maxUnbiasedValue = Math.floor(0x1_0000_0000 / limit) * limit;

  do {
    crypto.getRandomValues(randomValue);
  } while (randomValue[0] >= maxUnbiasedValue);

  return randomValue[0] % limit;
}

function validateRoomPhrase(
  normalized: string,
  missingError: RoomPhraseError | null,
): RoomPhraseParseResult {
  if (!normalized) {
    return { roomPhrase: null, error: missingError };
  }

  const words = normalized.split('-').filter(Boolean);
  if (words.length < ROOM_PHRASE_WORD_COUNT) {
    return { roomPhrase: null, error: 'incomplete' };
  }

  if (words.length !== ROOM_PHRASE_WORD_COUNT) {
    return { roomPhrase: null, error: 'invalid-format' };
  }

  if (words.some((word) => !ROOM_WORD_PATTERN.test(word))) {
    return { roomPhrase: null, error: 'invalid-format' };
  }

  if (new Set(words).size !== words.length) {
    return { roomPhrase: null, error: 'invalid-format' };
  }

  if (words.some((word) => !ROOM_WORD_SET.has(word))) {
    return { roomPhrase: null, error: 'unknown-word' };
  }

  return { roomPhrase: words.join('-'), error: null };
}

export function generateRoomPhrase(): string {
  const chosenIndexes = new Set<number>();

  while (chosenIndexes.size < ROOM_PHRASE_WORD_COUNT) {
    chosenIndexes.add(getRandomIndex(ROOM_WORDLIST.length));
  }

  return Array.from(chosenIndexes, (index) => ROOM_WORDLIST[index]).join('-');
}

export function formatRoomPhrase(roomPhrase: string): string {
  return roomPhrase.replace(/-/g, ' ');
}

export function getRoomPhraseErrorMessage(error: RoomPhraseError | null): string {
  switch (error) {
    case 'incomplete':
      return 'Enter all 3 words of the call phrase.';
    case 'unknown-word':
      return 'This phrase contains a word Telvy does not recognize.';
    case 'invalid-format':
    default:
      return 'Use exactly 3 words separated by spaces or hyphens.';
  }
}

function normalizeRoomPhrase(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function buildShareUrl(origin: string, roomPhrase: string): string {
  return `${origin}/#${encodeURIComponent(roomPhrase)}`;
}

export function parseCallUrl(url: URL): RoomPhraseParseResult {
  const hash = decodeURIComponent(url.hash.slice(1));
  return validateRoomPhrase(normalizeRoomPhrase(hash), null);
}

export function parseRoomPhraseInput(input: string, origin: string): RoomPhraseParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { roomPhrase: null, error: 'incomplete' };

  if (trimmed.includes('://') || trimmed.startsWith('/')) {
    try {
      const parsedUrl = parseCallUrl(new URL(trimmed, origin));
      return parsedUrl.roomPhrase || parsedUrl.error
        ? parsedUrl
        : { roomPhrase: null, error: 'invalid-format' };
    } catch {
      return { roomPhrase: null, error: 'invalid-format' };
    }
  }

  return validateRoomPhrase(normalizeRoomPhrase(trimmed), 'incomplete');
}
