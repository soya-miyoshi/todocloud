// Credential values in a type that cannot be printed.
//
// Every token the CLI handles is a Secret. `new Secret('')` is an absent
// secret. toString, Symbol.toPrimitive, toJSON and the inspect hook all
// return the redaction marker, so a secret that reaches a log line, an error
// message or --json output by accident is still not disclosed. The only way
// to obtain the underlying value is reveal, which is deliberately verbose at
// the call site.
//
// The backing value is a true private field (`#value`), so it is not an own
// property: JSON.stringify, Object.keys, a spread and structuredClone cannot
// reach it even without the hooks below.
//
// This module has no imports. It must keep working in a browser, so nothing
// here may reach for `node:crypto`; the fingerprint in hint uses the SHA-256
// implementation at the bottom of this file rather than Web Crypto, whose
// digest is async and would change hint's signature.

/** What a Secret renders as in every output path. */
export const REDACTED = '[REDACTED]';

/**
 * The key `util.inspect` and `console.log` look for on an object before they
 * format it themselves. Written as `Symbol.for` rather than imported from
 * `node:util`, which is how the symbol is registered and keeps this file free
 * of Node imports.
 */
const inspectCustom: unique symbol = Symbol.for('nodejs.util.inspect.custom');

/** Secret wraps a credential. It is immutable. */
export class Secret {
  readonly #value: string;

  /** Returns a Secret holding value. */
  constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  /**
   * Returns the underlying credential. Call it only where the value is about
   * to be handed to the provider, never to build a message for a human.
   */
  reveal(): string {
    return this.#value;
  }

  /** Reports whether no credential is set. */
  empty(): boolean {
    return this.#value === '';
  }

  /**
   * Tells one configured credential apart from another without disclosing
   * any part of either: the empty string when unset, otherwise the redaction
   * marker and a short fingerprint, `[REDACTED]#1a2b3c4d`.
   *
   * The question hint exists to answer is "did tdo pick up the token I just
   * rotated?", which `token_present: true` cannot answer. An earlier version
   * answered it with the last four characters of the value. That was a poor
   * trade: four characters are useless to an attacker but they are still four
   * real characters of a credential, landing wherever `tdo config` output
   * lands — a scrollback, a screenshot, an issue — and the docs promise that
   * this output is safe to paste. A fingerprint keeps the promise true.
   *
   * It is a plain hash rather than a keyed one so that two origins of the same
   * token (the environment and the keychain, say) fingerprint alike and can be
   * compared in one glance. That makes it an offline verifier: someone holding
   * the fingerprint could confirm a guess at the secret. For the provider
   * tokens this tool handles — high-entropy values nobody guesses — that is
   * not a real attack, and it is strictly less disclosure than printing part
   * of the value. Eight hex digits is plenty to notice a change and far too
   * few to be mistaken for the credential itself.
   */
  hint(): string {
    if (this.#value === '') {
      return '';
    }
    // The domain separator keeps these fingerprints from matching a bare
    // SHA-256 of the same token computed somewhere else.
    const sum = sha256(
      utf8('todocloud/secret-fingerprint/v1\u0000' + this.#value),
    );
    return REDACTED + '#' + hex(sum.subarray(0, 4));
  }

  /** The redaction marker, for String(), concatenation and `${}`. */
  toString(): string {
    return REDACTED;
  }

  /**
   * The redaction marker for every coercion, so neither a template literal
   * nor `'' + secret` can reach the underlying value. Without this hook a
   * subclass that dropped toString would fall back to Object.prototype.
   */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  /** The redaction marker, for JSON.stringify. */
  toJSON(): string {
    return REDACTED;
  }

  /** The redaction marker, for util.inspect and console.log. */
  [inspectCustom](): string {
    return REDACTED;
  }

  /**
   * Parses a secret out of a JSON value, so a secret read out of a JSON
   * credential file keeps its protection. The redaction marker is treated as
   * an absent value, which makes a redacted document safe to feed back in.
   */
  static fromJSON(value: unknown): Secret {
    if (typeof value !== 'string') {
      throw new TypeError('secret: expected a JSON string');
    }
    if (value === REDACTED || value.startsWith(REDACTED + '…')) {
      return new Secret('');
    }
    return new Secret(value);
  }
}

// --- SHA-256 -----------------------------------------------------------
//
// A credential must not travel through a third-party hash, and `node:crypto`
// is unavailable in a browser, so hint's fingerprint is computed here. This
// is the FIPS 180-4 algorithm with no streaming API: the one caller hashes a
// token-sized input in one go.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Encodes a string as UTF-8, without TextEncoder, which is host-provided. */
function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    s += b.toString(16).padStart(2, '0');
  }
  return s;
}

function sha256(message: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);

  // Pad to a multiple of 64 bytes: a 0x80 byte, zeros, then the length in
  // bits as a big-endian 64-bit integer.
  const bitLen = message.length * 8;
  const padded = new Uint8Array(
    Math.ceil((message.length + 9) / 64) * 64,
  );
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(off + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 =
        (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(i * 4, h[i] as number);
  }
  return out;
}
