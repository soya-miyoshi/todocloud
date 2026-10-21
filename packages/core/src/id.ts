// Module id generates and matches task identifiers.
//
// Ids are ULIDs: 26 Crockford base32 characters whose leading bits are a
// millisecond timestamp. They are generated on this machine, which every
// provider needs — Firestore has no autoincrement and the SQL providers should
// not have to read back an inserted row — and they sort lexicographically by
// creation time, so one ORDER BY works everywhere. Users rarely type one: the
// CLI resolves the short numbers `tdo ls` prints, and accepts an unambiguous
// id prefix as well.
//
// The ULID implementation is hand-written rather than taken from a package:
// this module has no runtime dependencies and must work unchanged in the
// browser, so the only primitive it reaches for is `crypto.getRandomValues`,
// which Node and browsers both provide as a global.

/** Length is the number of characters in a full id. */
export const Length = 26;

/** alphabet is Crockford base32: no I, L, O or U. */
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The randomness source, read off the global rather than imported, because
 * `node:crypto` does not exist in a browser and the global does exist in both.
 */
interface RandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function randomBytes(n: number): Uint8Array {
  const source = (globalThis as unknown as { crypto?: RandomSource }).crypto;
  if (source === undefined || typeof source.getRandomValues !== "function") {
    throw new Error("crypto.getRandomValues is unavailable, so no id can be generated");
  }
  return source.getRandomValues(new Uint8Array(n));
}

// The entropy is monotonic: within one millisecond it increments the previous
// value instead of drawing a fresh random one, so ids generated in a burst —
// `tdo import`, a script adding several tasks — keep the order they were
// created in. A ULID's timestamp is only millisecond-resolution, so plain
// random entropy would order a burst arbitrarily, and the whole point of
// sorting by id is that it matches creation order.
//
// Go guards the same state with a mutex because the generator is not safe for
// concurrent use. JavaScript needs no lock: `New` runs to completion without
// an await point, so no second caller can observe half-updated state.
const entropySize = 10; // 80 bits
const entropy = {
  /** The millisecond the current entropy value belongs to; -1 before the first id. */
  ms: -1,
  /** The 80-bit value, big-endian, as the ULID's trailing bytes. */
  value: new Uint8Array(entropySize),
};

/**
 * incrementBound is the largest step `New` may add to the previous entropy
 * within one millisecond. It matches oklog/ulid's default for an increment of
 * zero: a random step in [1, 2^32-1], which keeps the next id unguessable
 * while leaving 48 bits of headroom before the 80-bit value could overflow.
 */
const incrementBound = 0xffffffff;

function entropyIsZero(): boolean {
  for (const b of entropy.value) {
    if (b !== 0) {
      return false;
    }
  }
  return true;
}

/** randomIncrement returns a uniform step in [1, incrementBound]. */
function randomIncrement(): number {
  for (;;) {
    const b = randomBytes(4);
    // Indexed reads are checked, so fall back to 0 for a byte the compiler
    // cannot prove is there; a short read is impossible in practice.
    const inc =
      ((b[0] ?? 0) << 24 | (b[1] ?? 0) << 16 | (b[2] ?? 0) << 8 | (b[3] ?? 0)) >>> 0;
    if (inc !== 0 && inc <= incrementBound) {
      return inc;
    }
  }
}

/**
 * addToEntropy adds inc to the 80-bit entropy in place and reports whether it
 * overflowed. An overflow means more than 2^80 / 2^31 ids in one millisecond;
 * it cannot happen, and if it somehow did, returning an out-of-order id would
 * be worse than failing, so `New` throws on it.
 */
function addToEntropy(inc: number): boolean {
  let carry = inc;
  for (let i = entropySize - 1; i >= 0 && carry > 0; i--) {
    const sum = (entropy.value[i] ?? 0) + (carry % 256);
    entropy.value[i] = sum & 0xff;
    carry = Math.floor(carry / 256) + (sum > 0xff ? 1 : 0);
  }
  return carry > 0;
}

/** maxTime is the largest millisecond a 48-bit ULID timestamp can hold. */
const maxTime = 281474976710655; // 2^48 - 1

/**
 * encode renders a 48-bit timestamp and the 80-bit entropy as 26 Crockford
 * base32 characters. The two are one 128-bit number, left-padded into 130
 * bits of base32, so the leading character is never above '7' and the
 * lexicographic order of the text is the numeric order of the value — which
 * is the property the whole id scheme rests on.
 */
function encode(ms: number, value: Uint8Array): string {
  let n = BigInt(ms);
  for (const b of value) {
    n = (n << 8n) | BigInt(b);
  }
  const out = new Array<string>(Length);
  for (let i = Length - 1; i >= 0; i--) {
    out[i] = alphabet[Number(n & 31n)] as string;
    n >>= 5n;
  }
  return out.join("");
}

/** New returns a new id for a task created now. */
export function New(): string {
  const ms = Date.now();
  if (ms < 0 || ms > maxTime) {
    throw new Error(`the current time ${ms} does not fit a ULID timestamp`);
  }

  if (!entropyIsZero() && entropy.ms === ms) {
    if (addToEntropy(randomIncrement())) {
      throw new Error("monotonic entropy overflowed within one millisecond");
    }
  } else {
    // A fresh draw, both for a new millisecond and for a clock that moved
    // backwards. Go does the same, and the ids either side of a backwards
    // step are out of order in both languages; the alternative — pinning the
    // old timestamp — would date a task wrongly for as long as the skew.
    entropy.value.set(randomBytes(entropySize));
    entropy.ms = ms;
  }
  return encode(ms, entropy.value);
}

/** Valid reports whether s is a syntactically complete id. */
export function Valid(s: string): boolean {
  const v = s.toUpperCase();
  if (v.length !== Length) {
    return false;
  }
  for (const r of v) {
    if (!alphabet.includes(r)) {
      return false;
    }
  }
  // 26 base32 characters can express more than 128 bits, so a leading
  // character above '7' is a value no ULID can hold. Go's ParseStrict rejects
  // it as an overflow; so does this.
  return v[0] !== undefined && v[0] <= "7";
}

/**
 * Normalize upper-cases an id or prefix, since base32 is case-insensitive and
 * a user may paste a lower-cased copy.
 */
export function Normalize(s: string): string {
  return s.trim().toUpperCase();
}

/**
 * ValidPrefix reports whether s could be the start of an id. It rejects the
 * characters Crockford base32 excludes, so a typo is reported as a bad
 * reference rather than silently matching nothing.
 */
export function ValidPrefix(s: string): boolean {
  // The length is measured before trimming, as Go measures it: a reference
  // padded out past an id's width is not a prefix of anything.
  if (s === "" || s.length > Length) {
    return false;
  }
  for (const r of Normalize(s)) {
    if (!alphabet.includes(r)) {
      return false;
    }
  }
  return true;
}

/** Short returns the leading n characters of an id, for display. */
export function Short(id: string, n: number): string {
  if (n <= 0 || n >= id.length) {
    return id;
  }
  return id.slice(0, n);
}

/** ErrBadPrefix describes a reference that cannot be an id prefix. */
export function ErrBadPrefix(ref: string): Error {
  return new Error(`${JSON.stringify(ref)} is neither a task number nor an id prefix`);
}
