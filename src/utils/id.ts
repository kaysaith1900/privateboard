/**
 * Tiny URL-safe ID generator. Roughly nanoid-compatible: 12 chars from a 32-symbol
 * alphabet → ~60 bits of entropy. Good enough for in-process room/message IDs;
 * collisions astronomical.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // skip i, l, o, u for readability
const ALPHABET_LEN = ALPHABET.length;
const MASK = (1 << 5) - 1; // 5 bits per symbol (32 = 2^5)

export function newId(len = 12): string {
  // Generate a few extra bytes to absorb the ~6% rejection rate for masked
  // values that fall outside ALPHABET (in our case: none, since 32 fills 5 bits exactly).
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i]! & MASK];
  }
  return out;
}
