/**
 * ChaCha20-Poly1305 (RFC 8439), the AEAD of the age file format. WebCrypto
 * has no ChaCha20, and the API takes no crypto dependency, so it lives here:
 * a plain ChaCha20 block function and a Poly1305 over 13-bit limbs, whose
 * products stay exact in float64 arithmetic.
 *
 * Checked against RFC 8439's test vectors and, through `./age-file`, against
 * files `filippo.io/age` wrote (`test/age-file.test.ts`).
 *
 * @module
 */

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const;

/** Bytes of a key. */
export const CHACHA20_POLY1305_KEY_BYTES = 32;

/** Bytes of a nonce. */
export const CHACHA20_POLY1305_NONCE_BYTES = 12;

/** Bytes of the tag appended to every ciphertext. */
export const CHACHA20_POLY1305_TAG_BYTES = 16;

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function rotl(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

/** One 64-byte ChaCha20 keystream block into `out`. */
function chachaBlock(key: Uint32Array, nonce: Uint32Array, counter: number, out: Uint8Array): void {
  const s = new Uint32Array(16);
  s[0] = SIGMA[0];
  s[1] = SIGMA[1];
  s[2] = SIGMA[2];
  s[3] = SIGMA[3];
  s.set(key, 4);
  s[12] = counter >>> 0;
  s.set(nonce, 13);
  const x = s.slice();
  const qr = (a: number, b: number, c: number, d: number) => {
    x[a] = (x[a]! + x[b]!) >>> 0;
    x[d] = rotl(x[d]! ^ x[a]!, 16);
    x[c] = (x[c]! + x[d]!) >>> 0;
    x[b] = rotl(x[b]! ^ x[c]!, 12);
    x[a] = (x[a]! + x[b]!) >>> 0;
    x[d] = rotl(x[d]! ^ x[a]!, 8);
    x[c] = (x[c]! + x[d]!) >>> 0;
    x[b] = rotl(x[b]! ^ x[c]!, 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12);
    qr(1, 5, 9, 13);
    qr(2, 6, 10, 14);
    qr(3, 7, 11, 15);
    qr(0, 5, 10, 15);
    qr(1, 6, 11, 12);
    qr(2, 7, 8, 13);
    qr(3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) {
    const v = (x[i]! + s[i]!) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = v >>> 24;
  }
}

function words(bytes: Uint8Array, count: number): Uint32Array {
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = u32le(bytes, i * 4);
  return out;
}

/**
 * XORs `input` with the ChaCha20 keystream from block `counter` on.
 *
 * @param key - 32 bytes.
 * @param nonce - 12 bytes.
 * @param counter - First block counter.
 * @param input - Bytes to encrypt or decrypt.
 * @returns A new array.
 */
export function chacha20(
  key: Uint8Array,
  nonce: Uint8Array,
  counter: number,
  input: Uint8Array,
): Uint8Array {
  if (key.byteLength !== CHACHA20_POLY1305_KEY_BYTES) throw new Error("ChaCha20 keys are 32 bytes");
  if (nonce.byteLength !== CHACHA20_POLY1305_NONCE_BYTES) {
    throw new Error("ChaCha20 nonces are 12 bytes");
  }
  // SECURITY: the block counter is 32 bits; running past it would silently
  // wrap and reuse keystream under the same nonce.
  if (
    !Number.isInteger(counter) ||
    counter < 0 ||
    counter + Math.ceil(input.byteLength / 64) > 2 ** 32
  ) {
    throw new Error("ChaCha20 block counter out of range");
  }
  const k = words(key, 8);
  const n = words(nonce, 3);
  const out = new Uint8Array(input.byteLength);
  const block = new Uint8Array(64);
  for (let offset = 0, c = counter; offset < input.byteLength; offset += 64, c++) {
    chachaBlock(k, n, c, block);
    const end = Math.min(64, input.byteLength - offset);
    for (let i = 0; i < end; i++) out[offset + i] = input[offset + i]! ^ block[i]!;
  }
  return out;
}

const LIMB = 8192;
const P = (1n << 130n) - 5n;

/** Splits 16 little-endian bytes into ten 13-bit limbs, adding `hibit` at bit 128. */
function limbs(b: Uint8Array, offset: number, into: number[], hibit: number): void {
  const t = (i: number) => b[offset + 2 * i]! | (b[offset + 2 * i + 1]! << 8);
  const t0 = t(0);
  const t1 = t(1);
  const t2 = t(2);
  const t3 = t(3);
  const t4 = t(4);
  const t5 = t(5);
  const t6 = t(6);
  const t7 = t(7);
  into[0] = t0 & 0x1fff;
  into[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
  into[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1fff;
  into[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
  into[4] = ((t3 >>> 4) | (t4 << 12)) & 0x1fff;
  into[5] = (t4 >>> 1) & 0x1fff;
  into[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
  into[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1fff;
  into[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
  into[9] = (t7 >>> 5) | hibit;
}

function bigLe(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.byteLength - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

/**
 * Poly1305 of a message under a one-time key.
 *
 * Internal: h = (h + m) · r mod 2^130 − 5 per 16-byte block over ten 13-bit
 * limbs. Every partial product is below 2^34, so float64 stays exact; one
 * carry pass folds the overflow back in as × 5. The final reduction and the
 * addition of `s` happen once, in BigInt.
 *
 * @param key - 32-byte one-time key (`r` then `s`).
 * @param message - The message.
 * @returns The 16-byte tag.
 */
export function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new Error("Poly1305 keys are 32 bytes");
  const rb = key.slice(0, 16);
  rb[3] = rb[3]! & 15;
  rb[7] = rb[7]! & 15;
  rb[11] = rb[11]! & 15;
  rb[15] = rb[15]! & 15;
  rb[4] = rb[4]! & 252;
  rb[8] = rb[8]! & 252;
  rb[12] = rb[12]! & 252;
  const r: number[] = new Array(10);
  limbs(rb, 0, r, 0);
  const r5 = r.map((v) => v * 5);
  const h = new Array<number>(10).fill(0);
  const m: number[] = new Array(10);
  const d = new Array<number>(10);
  const last = new Uint8Array(16);
  for (let offset = 0; offset < message.byteLength; offset += 16) {
    const left = message.byteLength - offset;
    if (left >= 16) {
      limbs(message, offset, m, 1 << 11);
    } else {
      last.fill(0);
      last.set(message.subarray(offset));
      last[left] = 1;
      limbs(last, 0, m, 0);
    }
    for (let i = 0; i < 10; i++) h[i] = h[i]! + m[i]!;
    for (let i = 0; i < 10; i++) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += h[j]! * r[i - j]!;
      for (let j = i + 1; j < 10; j++) sum += h[j]! * r5[i - j + 10]!;
      d[i] = sum;
    }
    let c = 0;
    for (let i = 0; i < 10; i++) {
      const v = d[i]! + c;
      c = Math.floor(v / LIMB);
      h[i] = v - c * LIMB;
    }
    const h0 = h[0]! + c * 5;
    c = Math.floor(h0 / LIMB);
    h[0] = h0 - c * LIMB;
    h[1] = h[1]! + c;
  }
  let acc = 0n;
  for (let i = 9; i >= 0; i--) acc = (acc << 13n) + BigInt(h[i]!);
  const tag = ((acc % P) + bigLe(key.subarray(16))) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  let v = tag;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function macData(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const pad = (n: number) => (16 - (n % 16)) % 16;
  const aadEnd = aad.byteLength + pad(aad.byteLength);
  const ctEnd = aadEnd + ciphertext.byteLength + pad(ciphertext.byteLength);
  const out = new Uint8Array(ctEnd + 16);
  out.set(aad, 0);
  out.set(ciphertext, aadEnd);
  const view = new DataView(out.buffer);
  view.setBigUint64(ctEnd, BigInt(aad.byteLength), true);
  view.setBigUint64(ctEnd + 8, BigInt(ciphertext.byteLength), true);
  return out;
}

function polyKey(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  return chacha20(key, nonce, 0, new Uint8Array(32));
}

/**
 * Encrypts and authenticates.
 *
 * @param key - 32 bytes.
 * @param nonce - 12 bytes; never reuse one under the same key.
 * @param plaintext - The message.
 * @param aad - Authenticated, unencrypted data.
 * @returns Ciphertext followed by the 16-byte tag.
 */
export function chacha20poly1305Seal(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const ciphertext = chacha20(key, nonce, 1, plaintext);
  const out = new Uint8Array(ciphertext.byteLength + CHACHA20_POLY1305_TAG_BYTES);
  out.set(ciphertext);
  out.set(poly1305(polyKey(key, nonce), macData(aad, ciphertext)), ciphertext.byteLength);
  return out;
}

/**
 * Verifies and decrypts.
 *
 * @param key - 32 bytes.
 * @param nonce - 12 bytes.
 * @param sealed - Ciphertext followed by the tag.
 * @param aad - The data authenticated with it.
 * @returns The plaintext.
 * @throws {Error} When the tag doesn't verify.
 */
export function chacha20poly1305Open(
  key: Uint8Array,
  nonce: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (sealed.byteLength < CHACHA20_POLY1305_TAG_BYTES) throw new Error("ciphertext too short");
  const split = sealed.byteLength - CHACHA20_POLY1305_TAG_BYTES;
  const ciphertext = sealed.subarray(0, split);
  const expected = poly1305(polyKey(key, nonce), macData(aad, ciphertext));
  let diff = 0;
  for (let i = 0; i < CHACHA20_POLY1305_TAG_BYTES; i++) diff |= expected[i]! ^ sealed[split + i]!;
  if (diff !== 0) throw new Error("ChaCha20-Poly1305 authentication failed");
  return chacha20(key, nonce, 1, ciphertext);
}
