// The port of internal/cli/import_fuzz_test.go — `FuzzDecodeImport`.
//
// `decodeImport` reads a file the user names on the command line, in three
// formats, one of which is driven by a hand-written column index. Whatever the
// bytes are, it must not crash, and it must not return a task alongside an
// error.
//
// Go had `go test -fuzz`; Node has no fuzzer, so the target is ported as a
// seeded property test, the shape `packages/cli/src/toml.test.ts` and
// `packages/core/src/providercli.test.ts` already established:
//
//   - every seed the Go target added with `f.Add` is an explicit case below,
//     so the corpus is not lost;
//   - the inputs the coverage-guided engine would have evolved are replaced
//     by generated ones, from a 32-bit xorshift PRNG with a fixed seed.
//     Determinism is the point: a failure prints the seed, the iteration and
//     the input, and the same run reproduces it, which is what
//     `testdata/fuzz` gave Go.
//
// What is gone is coverage guidance: these inputs are generated from a
// hostile grammar rather than evolved towards new branches, so this is a
// weaker instrument than a fuzzer and is not a reason to stop running one if
// the tree ever gains the means.
//
// One invariant moved from an assertion to the type system. Go returned
// `(ImportFile, error)` and could therefore return both at once, which is
// what the target's first check was about; the port throws instead, so a
// rejection cannot carry tasks. What is left to assert about a rejection is
// that it is an ordinary reported error rather than a crash — a TypeError or
// a RangeError out of the decoder is the Node equivalent of the panic the Go
// target was watching for.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { forTest } from './transfer.ts';

const { decodeImport } = forTest;

/** iterations is how many generated inputs the property test runs. */
const iterations = 4000;

/** prngSeed is fixed, so that a failure is reproducible to the iteration. */
const prngSeed = 0x1c9f0ad;

/**
 * xorshift32 is the smallest PRNG that is good enough here: the generator
 * needs spread, not statistical quality, and a hand-written one keeps the
 * zero-dependency rule and makes the sequence identical on every machine and
 * every Node version.
 */
function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

// The three well-formed documents the Go target started from.
const envelope =
  '{"version":1,"exported_at":"2026-10-20T04:11:00Z","store":"sqlite: /tmp/tasks.db",' +
  '"tasks":[{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","title":"Pay the invoice","done":false,' +
  '"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z",' +
  '"due":"2026-11-01","priority":2,"tags":["finance"],"client":"acme"}]}';
const bareArray =
  '[{"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ","title":"one","done":true,' +
  '"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z",' +
  '"completed_at":"2026-10-20T05:00:00Z"}]';
const csvForm =
  'id,title,done,created_at,updated_at,completed_at,deleted_at,fields\r\n' +
  '01J3ABCDEFGHJKMNPQRSTVWXYZ,Pay the invoice,false,2026-10-20T04:11:00Z,2026-10-20T04:11:00Z,,,"{""client"":""acme""}"\r\n';

/** seeds is every `f.Add` of the Go target, in its order. */
const seeds: readonly string[] = [
  '',
  ' \t\r\n',
  // Go added the UTF-8 byte-order mark as raw bytes; the character is the
  // same thing once the file has been decoded, which is where this port's
  // decoder starts.
  '﻿' + envelope,
  envelope,
  bareArray,
  csvForm,

  // Mutations of the envelope.
  '{}',
  '{"tasks":null}',
  '{"tasks":"nope"}',
  '{"tasks":[]}',
  '{"tasks":[null]}',
  '{"tasks":[{}]}',
  '{"tasks":{"a":1}}',
  envelope.replace('"title":"Pay the invoice"', '"title":""'),
  envelope.replace('"created_at":"2026-10-20T04:11:00Z"', '"created_at":"yesterday"'),
  envelope.replace('"priority":2', '"priority":99'),
  envelope.replace('"due":"2026-11-01"', '"due":"not a date"'),
  envelope.slice(0, Math.floor(envelope.length / 2)),

  // Mutations of the bare array.
  '[',
  '[]',
  '[1,2,3]',
  '["a"]',
  '[{"id":1}]',
  bareArray.slice(0, 20),

  // Mutations of the CSV form.
  'id,title,done,created_at,updated_at\n',
  'id,title\n1,x\n',
  csvForm + 'short,row\n',
  csvForm.replace('false', 'maybe'),
  csvForm.replace('"{""client"":""acme""}"', '"{not json}"'),
  'id,title,done,created_at,updated_at,fields\nx,"a\nnewline",false,2026-10-20T04:11:00Z,2026-10-20T04:11:00Z,{}\n',
  'id,title,done,created_at,updated_at\nx,"unclosed,false,,\n',

  // Not any of the three formats.
  'hello',
  '\u0000\u0001\u0002',
  // Go's corpus held the invalid UTF-8 bytes \xff\xfe; the replacement
  // character is what a file holding them decodes to.
  '��',
  'null',
  'true',
  '42',
  'a,b,c\n'.repeat(500),
];

/**
 * fragments are the pieces a generated input is assembled from: the openers
 * that choose a format, the keys and values the decoders branch on, and
 * enough hostility to reach the edges of each one.
 */
const fragments: readonly string[] = [
  '{', '}', '[', ']', '(', ')', ',', ':', '"', '\\', "'",
  '\r', '\n', '\t', ' ', '\u0000', '﻿', '�', '\ud800',
  '"tasks"', '"perspectives"', '"id"', '"title"', '"done"', '"fields"',
  '"created_at"', '"updated_at"', '"completed_at"', '"deleted_at"',
  '"priority"', '"tags"', '"kind"', '"status"', '"parent_id"', '"repeat"',
  'null', 'true', 'false', '0', '-1', '99', '1e309', '{}', '[]',
  '"01J3ABCDEFGHJKMNPQRSTVWXYZ"', '"not-a-ulid"', '""',
  '"2026-10-20T04:11:00Z"', '"yesterday"', '"2026-11-01"',
  'id,title,done,created_at,updated_at',
  'id,title,done,created_at,updated_at,completed_at,deleted_at,fields',
  'fields,id',
  'x,y,z',
  '""""',
  '"{""client"":""acme""}"',
];

/**
 * taskFragments are the key/value pairs a generated task object is built
 * from: the well-formed spellings, and the near misses beside them.
 */
const taskFragments: readonly string[] = [
  '"id":"01J3ABCDEFGHJKMNPQRSTVWXYZ"',
  '"id":"01j3abcdefghjkmnpqrstvwxyz"',
  '"id":""',
  '"title":"Pay the invoice"',
  '"title":""',
  '"kind":"task"',
  '"kind":"project"',
  '"kind":"nonsense"',
  '"status":"active"',
  '"status":"dropped"',
  '"done":true',
  '"done":false',
  '"created_at":"2026-10-20T04:11:00Z"',
  '"updated_at":"2026-10-20T04:11:00Z"',
  '"completed_at":"2026-10-20T05:00:00Z"',
  '"deleted_at":null',
  '"due":"2026-11-01"',
  '"due":"not a date"',
  '"priority":2',
  '"priority":99',
  '"tags":["finance"]',
  '"tags":[]',
  '"client":"acme"',
  '"estimated_minutes":25',
  '"repeat":"1w"',
  '"parent_id":null',
];

/**
 * generateValid builds a document that is meant to be accepted, in one of the
 * three formats. Hostile input reaches the accepted side far too rarely on
 * its own, and the invariants about an accepted file are half the target.
 */
function generateValid(rand: () => number): string {
  const taskObject = (): string => {
    const fields = new Set<string>(['"created_at":"2026-10-20T04:11:00Z"', '"updated_at":"2026-10-20T04:11:00Z"']);
    const count = rand() % 8;
    for (let i = 0; i <= count; i++) {
      fields.add(taskFragments[rand() % taskFragments.length] ?? '');
    }
    return `{${[...fields].join(',')}}`;
  };
  const count = rand() % 4;
  const tasks: string[] = [];
  for (let i = 0; i <= count; i++) {
    // A JSON null now and then, which is the one input that may leave a hole
    // in the decoded list.
    tasks.push(rand() % 12 === 0 ? 'null' : taskObject());
  }

  switch (rand() % 3) {
    case 0:
      return `[${tasks.join(',')}]`;
    case 1:
      return `{"version":1,"tasks":[${tasks.join(',')}]${rand() % 2 === 0 ? ',"perspectives":[]' : ''}}`;
    default: {
      // The CSV form, whose column index is hand-written and therefore the
      // part most worth generating rows for.
      const rows = [
        'id,title,done,created_at,updated_at,completed_at,deleted_at,fields',
      ];
      for (let i = 0; i < tasks.length; i++) {
        rows.push(
          `01J3ABCDEFGHJKMNPQRSTVW${String(i).padStart(3, '0')},` +
            `${rand() % 4 === 0 ? '"a, quoted title"' : 'Pay the invoice'},` +
            `${rand() % 2 === 0 ? 'true' : 'false'},` +
            '2026-10-20T04:11:00Z,2026-10-20T04:11:00Z,,,' +
            (rand() % 3 === 0 ? '"{""client"":""acme""}"' : '{}'),
        );
      }
      return rows.join('\r\n') + '\r\n';
    }
  }
}

/** generate builds one input from the PRNG. */
function generate(rand: () => number): string {
  // One in three is built to be accepted; the rest are hostile.
  if (rand() % 3 === 0) {
    return generateValid(rand);
  }
  // One in four starts from a seed and mutates it, which is how a generated
  // input reaches the paths that only a nearly-valid document reaches.
  const parts: string[] = [];
  if (rand() % 4 === 0) {
    const seed = seeds[rand() % seeds.length] ?? '';
    const cut = seed.length === 0 ? 0 : rand() % seed.length;
    parts.push(seed.slice(0, cut));
  }
  const pieces = rand() % 24;
  for (let i = 0; i <= pieces; i++) {
    if (rand() % 8 === 0) {
      // A long run, so the CSV reader meets a field worth its own branch.
      parts.push((fragments[rand() % fragments.length] ?? '').repeat(1 + (rand() % 40)));
      continue;
    }
    parts.push(fragments[rand() % fragments.length] ?? '');
  }
  return parts.join('');
}

/**
 * checkInvariants is `f.Fuzz`'s body: either a reported rejection, or a file
 * whose tasks are all usable.
 */
function checkInvariants(data: string, where: string): void {
  let file;
  try {
    file = decodeImport(data);
  } catch (err) {
    // A rejection must be a reported error and not a crash. A TypeError or a
    // RangeError means the decoder ran off the end of something it did not
    // check, which is what the Go target's "must not panic" was about.
    assert.ok(err instanceof Error, `${where}: threw a non-Error: ${String(err)}`);
    assert.ok(
      !(err instanceof TypeError) && !(err instanceof RangeError),
      `${where}: crashed rather than reporting: ${err.stack ?? err.message}`,
    );
    assert.notEqual(err.message, '', `${where}: rejected the file without saying why`);
    return;
  }

  assert.ok(Array.isArray(file.tasks), `${where}: tasks is not an array`);
  assert.ok(Array.isArray(file.perspectives), `${where}: perspectives is not an array`);

  for (const [i, decoded] of file.tasks.entries()) {
    if (decoded === undefined) {
      // The known defect Go pinned the same way: only a literal JSON null may
      // produce a hole in the list. `tdo import` rejects such a file rather
      // than dereferencing the hole, which transfer.test.ts asserts.
      assert.ok(
        data.includes('null'),
        `${where}: task ${i} is missing for an input with no JSON null`,
      );
      continue;
    }
    // Fields is documented as never nil on a decoded task.
    assert.ok(
      decoded.fields !== undefined && decoded.fields !== null,
      `${where}: task ${i} has no fields`,
    );
  }
}

test(`decodeImport holds its invariants over the ${seeds.length} seed-corpus inputs`, () => {
  for (const [i, data] of seeds.entries()) {
    checkInvariants(data, `seed ${i} ${JSON.stringify(data.slice(0, 60))}`);
  }
});

test(`decodeImport holds its invariants over ${iterations} generated inputs`, () => {
  const rand = xorshift32(prngSeed);
  for (let i = 0; i < iterations; i++) {
    const data = generate(rand);
    checkInvariants(data, `iteration ${i} (seed 0x${prngSeed.toString(16)}) ${JSON.stringify(data)}`);
  }
});

test('the PRNG is deterministic and never sticks at zero', () => {
  const a = xorshift32(prngSeed);
  const b = xorshift32(prngSeed);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  // A zero seed would stick at zero, so it is replaced by a fixed constant.
  assert.notEqual(xorshift32(0)(), 0);
});
