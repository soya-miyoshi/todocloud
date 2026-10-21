import { test } from "node:test";
import assert from "node:assert/strict";

import { ErrBadPrefix, Length, New, Normalize, Short, Valid, ValidPrefix } from "./id.ts";

test("New produces valid ids", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const got = New();
    assert.equal(got.length, Length, `New() = ${got}, want ${Length} characters`);
    assert.ok(Valid(got), `New() produced ${got}, which Valid rejects`);
    assert.ok(!seen.has(got), `New() repeated ${got}`);
    seen.add(got);
  }
});

// Lexicographic order must equal creation order even within a single
// millisecond. A ULID's timestamp is millisecond-resolution, so without
// monotonic entropy a burst of ids would sort arbitrarily — and `tdo ls`
// orders by id, which is what the short numbers are assigned from. An
// arbitrary order there means `tdo done 1` can complete the wrong task.
test("ids generated in one burst sort in creation order", () => {
  const ids: string[] = [];
  for (let i = 0; i < 500; i++) {
    ids.push(New());
  }

  const sorted = [...ids].sort();
  for (let i = 0; i < ids.length; i++) {
    assert.equal(
      ids[i],
      sorted[i],
      `id ${i} of a burst is out of order:\n generated: ${ids[i]}\n    sorted: ${sorted[i]}`,
    );
  }
});

// Generating from several concurrent tasks must stay ordered per observation
// and must never produce a duplicate. Go runs this across goroutines as the
// race detector's entry point into the shared generator; JavaScript has no
// such race, because `New` has no await point, so the equivalent here is
// interleaved async callers — it proves the shared state survives being
// reached from many places, which is what the Go test is for.
test("concurrent generation is unique and valid", async () => {
  const workers = 8;
  const each = 200;

  const results = await Promise.all(
    Array.from({ length: workers }, async () => {
      const out: string[] = [];
      for (let i = 0; i < each; i++) {
        await Promise.resolve();
        out.push(New());
      }
      return out;
    }),
  );

  const seen = new Set<string>();
  for (const got of results.flat()) {
    assert.ok(Valid(got), `New() produced ${got}, which Valid rejects`);
    assert.ok(!seen.has(got), `New() repeated ${got} across tasks`);
    seen.add(got);
  }
  assert.equal(seen.size, workers * each, `got ${seen.size} distinct ids, want ${workers * each}`);
});

// The same property across a span of time, which is what a user's list relies
// on over days rather than milliseconds.
test("ids sort by creation time", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(New());
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  const sorted = [...ids].sort();
  assert.deepEqual(
    ids,
    sorted,
    `ids are not in lexicographic creation order:\n generated: ${ids}\n    sorted: ${sorted}`,
  );
});

// The encoding itself, checked against a clock this test controls. The
// leading ten characters must decode back to the millisecond they were made
// in: a byte-swapped or little-endian timestamp would still produce 26 legal
// characters, and would still look unique, but it would sort by nothing.
test("the timestamp occupies the leading characters in big-endian order", () => {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const decodeTime = (id: string): number => {
    let n = 0n;
    for (const c of id.slice(0, 10)) {
      n = n * 32n + BigInt(alphabet.indexOf(c));
    }
    // Ten base32 characters hold 50 bits; the timestamp is the low 48 of
    // them, and the two above it are always zero.
    return Number(n);
  };

  const realNow = Date.now;
  try {
    for (const ms of [0, 1, 1_000_000_000_000, 281474976710655]) {
      Date.now = () => ms;
      const got = New();
      assert.equal(got.length, Length);
      assert.equal(decodeTime(got), ms, `the timestamp of ${got} did not decode to ${ms}`);
    }

    // And a later millisecond must sort after an earlier one whatever the
    // entropy is, which is the property `tdo ls` orders by.
    Date.now = () => 1_000_000_000_000;
    const earlier = New();
    Date.now = () => 1_000_000_000_001;
    const later = New();
    assert.ok(earlier < later, `${earlier} should sort before ${later}`);
  } finally {
    Date.now = realNow;
  }
});

test("Valid", () => {
  const valid = New();
  const tests: ReadonlyArray<{ name: string; in: string; want: boolean }> = [
    { name: "generated", in: valid, want: true },
    { name: "lower-cased copy", in: valid.toLowerCase(), want: true },
    { name: "too short", in: valid.slice(0, 25), want: false },
    { name: "too long", in: valid + "0", want: false },
    { name: "excluded letter I", in: "I".repeat(Length), want: false },
    { name: "empty", in: "", want: false },
  ];
  for (const tc of tests) {
    assert.equal(Valid(tc.in), tc.want, `Valid(${tc.in}) in case ${tc.name}`);
  }
});

test("ValidPrefix", () => {
  const tests: ReadonlyArray<{ name: string; in: string; want: boolean }> = [
    { name: "short prefix", in: "01J3", want: true },
    { name: "lower case", in: "01j3", want: true },
    { name: "surrounded by spaces", in: " 01J3 ", want: true },
    { name: "a full id is a prefix of itself", in: "01J3ZQK8V9XW5S6R7T8Y9Z0A1B", want: true },
    { name: "empty", in: "", want: false },
    { name: "longer than an id", in: "0".repeat(Length + 1), want: false },
    { name: "excluded letter L", in: "01L3", want: false },
    { name: "excluded letter O", in: "01O3", want: false },
    { name: "excluded letter U", in: "01U3", want: false },
    { name: "punctuation", in: "01-3", want: false },
  ];
  for (const tc of tests) {
    assert.equal(ValidPrefix(tc.in), tc.want, `ValidPrefix(${tc.in}) in case ${tc.name}`);
  }
});

test("Normalize", () => {
  assert.equal(Normalize(" 01j3 "), "01J3");
});

test("Short", () => {
  const full = "01J3ZQK8V9XW5S6R7T8Y9Z0A1B";
  const tests: ReadonlyArray<{ n: number; want: string }> = [
    { n: 4, want: "01J3" },
    { n: 0, want: full },
    { n: -1, want: full },
    { n: Length, want: full },
    { n: Length + 10, want: full },
  ];
  for (const tc of tests) {
    assert.equal(Short(full, tc.n), tc.want, `Short(id, ${tc.n})`);
  }
});

test("ErrBadPrefix names the reference it rejected", () => {
  assert.match(ErrBadPrefix("01-3").message, /^"01-3" is neither a task number nor an id prefix$/);
});
