const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
// Largest multiple of 62 below 256. Bytes at or above it are redrawn so every
// character is equally likely.
const UNBIASED_LIMIT = 248;
const SHARE_ID = /^[0-9A-Za-z]{8,16}$/;

export function shortId(length = 10): string {
  let id = '';
  while (id.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length))) {
      if (b < UNBIASED_LIMIT && id.length < length) id += ID_ALPHABET[b % ID_ALPHABET.length];
    }
  }
  return id;
}

export function isShareId(value: string): boolean {
  return SHARE_ID.test(value);
}
