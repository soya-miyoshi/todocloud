// The tests of `internal/config/toml_test.go` and
// `internal/config/toml_fuzz_test.go`.
//
// The fuzz target is the second half of this file. Go had `go test -fuzz`;
// Node has no fuzzer, so it is ported as a seeded property test over a small
// deterministic PRNG. That keeps the one thing a fuzz target is for — a
// failure that can be replayed — while running in the time a unit test may
// take.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTokenKey } from './config.ts';
import {
  checkBareKey,
  kindBool,
  kindInt,
  kindString,
  parseTOML,
  type TomlValue,
  type ValueKind,
} from './toml.ts';

/**
 * value builds an expected TomlValue, filling in the zero values the Go
 * struct literals left out.
 */
function value(partial: {
  kind?: ValueKind;
  str?: string;
  num?: bigint;
  flag?: boolean;
  line: number;
}): TomlValue {
  return {
    kind: partial.kind ?? kindString,
    str: partial.str ?? '',
    num: partial.num ?? 0n,
    flag: partial.flag ?? false,
    line: partial.line,
  };
}

test('parseTOML: the accepted forms', async (t) => {
  const cases: {
    name: string;
    src: string;
    table?: string;
    key: string;
    want: TomlValue;
  }[] = [
    {
      name: 'double quoted string',
      src: 'provider = "sqlite"',
      key: 'provider',
      want: value({ kind: kindString, str: 'sqlite', line: 1 }),
    },
    {
      name: 'single quoted literal string',
      src: "provider = 'turso'",
      key: 'provider',
      want: value({ kind: kindString, str: 'turso', line: 1 }),
    },
    {
      name: 'trailing comment after a string',
      src: 'provider = "sqlite" # the default',
      key: 'provider',
      want: value({ kind: kindString, str: 'sqlite', line: 1 }),
    },
    {
      name: 'hash inside a string is literal',
      src: 'url = "libsql://example.turso.io/#fragment"',
      key: 'url',
      want: value({
        kind: kindString,
        str: 'libsql://example.turso.io/#fragment',
        line: 1,
      }),
    },
    {
      name: 'hash inside a literal string is literal',
      src: "url = 'libsql://example.turso.io/#fragment'",
      key: 'url',
      want: value({
        kind: kindString,
        str: 'libsql://example.turso.io/#fragment',
        line: 1,
      }),
    },
    {
      name: 'escapes in a basic string',
      src: 'note = "a\\tb\\nc\\"d\\\\e"',
      key: 'note',
      want: value({ kind: kindString, str: 'a\tb\nc"d\\e', line: 1 }),
    },
    {
      name: 'bare integer',
      src: 'timeout = 30',
      key: 'timeout',
      want: value({ kind: kindInt, num: 30n, line: 1 }),
    },
    {
      name: 'negative integer with a trailing comment',
      src: 'offset = -5 # behind',
      key: 'offset',
      want: value({ kind: kindInt, num: -5n, line: 1 }),
    },
    {
      name: 'true',
      src: 'color = true',
      key: 'color',
      want: value({ kind: kindBool, flag: true, line: 1 }),
    },
    {
      name: 'false',
      src: 'color = false',
      key: 'color',
      want: value({ kind: kindBool, flag: false, line: 1 }),
    },
    {
      name: 'table header',
      src: '[turso]\nurl = "libsql://example.turso.io"',
      table: 'turso',
      key: 'url',
      want: value({
        kind: kindString,
        str: 'libsql://example.turso.io',
        line: 2,
      }),
    },
    {
      name: 'table header with a trailing comment',
      src: '[sqlite] # local\npath = "/tmp/tasks.db"',
      table: 'sqlite',
      key: 'path',
      want: value({ kind: kindString, str: '/tmp/tasks.db', line: 2 }),
    },
    {
      name: 'surrounding whitespace and blank lines',
      src: '\n   # comment\n\n\t[d1]  \n   account_id   =   "00000000-0000-0000-0000-000000000000"   \n',
      table: 'd1',
      key: 'account_id',
      want: value({
        kind: kindString,
        str: '00000000-0000-0000-0000-000000000000',
        line: 5,
      }),
    },
    {
      name: 'crlf line endings',
      src: '[turso]\r\nurl = "libsql://example.turso.io"\r\n',
      table: 'turso',
      key: 'url',
      want: value({
        kind: kindString,
        str: 'libsql://example.turso.io',
        line: 2,
      }),
    },
    {
      name: 'key with an underscore and a dash',
      src: 'project_id = "my-project-id"',
      key: 'project_id',
      want: value({ kind: kindString, str: 'my-project-id', line: 1 }),
    },
    {
      name: 'empty string value',
      src: 'path = ""',
      key: 'path',
      want: value({ kind: kindString, str: '', line: 1 }),
    },
    {
      name: 'same key in two different tables',
      src: '[turso]\ntoken_hint = "a"\n[d1]\ntoken_hint = "b"',
      table: 'd1',
      key: 'token_hint',
      want: value({ kind: kindString, str: 'b', line: 4 }),
    },
  ];

  for (const tt of cases) {
    await t.test(tt.name, () => {
      const f = parseTOML(tt.src);
      const got = f.lookup(tt.table ?? '', tt.key);
      assert.ok(
        got !== undefined,
        `key ${tt.key} in table ${tt.table ?? ''} not found`,
      );
      assert.deepEqual(got, tt.want);
    });
  }
});

test('parseTOML: the rejections', async (t) => {
  const cases: {
    name: string;
    src: string;
    wantLine: string;
    wantText: string;
  }[] = [
    {
      name: 'unterminated double quoted string',
      src: 'provider = "sqlite',
      wantLine: 'line 1:',
      wantText: 'unterminated string',
    },
    {
      name: 'unterminated literal string on a later line',
      src: "# comment\n[turso]\nurl = 'libsql://example.turso.io",
      wantLine: 'line 3:',
      wantText: 'unterminated string',
    },
    {
      name: 'bare word line',
      src: 'provider = "sqlite"\nnonsense',
      wantLine: 'line 2:',
      wantText: 'expected a comment, a [table] header or a key = value pair',
    },
    {
      name: 'duplicate key in the same table',
      src: '[turso]\nurl = "libsql://example.turso.io"\nurl = "libsql://example.turso.io"',
      wantLine: 'line 3:',
      wantText: 'duplicate key',
    },
    {
      name: 'duplicate key at the top level',
      src: 'provider = "sqlite"\nprovider = "turso"',
      wantLine: 'line 2:',
      wantText: 'duplicate key',
    },
    {
      name: 'nested table header',
      src: '[a.b]\nkey_name = "v"',
      wantLine: 'line 1:',
      wantText: 'nested table header',
    },
    {
      name: 'array value',
      src: '[sqlite]\npaths = ["a", "b"]',
      wantLine: 'line 2:',
      wantText: 'array values are not supported',
    },
    {
      name: 'inline table value',
      src: 'sqlite = { path = "a" }',
      wantLine: 'line 1:',
      wantText: 'inline table values are not supported',
    },
    {
      name: 'array of tables header',
      src: '[[turso]]\nurl = "libsql://example.turso.io"',
      wantLine: 'line 1:',
      wantText: 'array-of-tables headers are not supported',
    },
    {
      name: 'unterminated table header',
      src: '[turso\nurl = "libsql://example.turso.io"',
      wantLine: 'line 1:',
      wantText: 'unterminated table header',
    },
    {
      name: 'text after the table header',
      src: '[turso] junk',
      wantLine: 'line 1:',
      wantText: 'unexpected text after the table header',
    },
    {
      name: 'text after a string value',
      src: 'provider = "sqlite" junk',
      wantLine: 'line 1:',
      wantText: 'unexpected text after the value',
    },
    {
      name: 'missing value',
      src: 'provider =',
      wantLine: 'line 1:',
      wantText: 'missing value after =',
    },
    {
      name: 'empty key',
      src: '= "sqlite"',
      wantLine: 'line 1:',
      wantText: 'empty key',
    },
    {
      name: 'dotted key',
      src: 'turso.url = "libsql://example.turso.io"',
      wantLine: 'line 1:',
      wantText: 'invalid character',
    },
    {
      name: 'float value',
      src: 'timeout = 1.5',
      wantLine: 'line 1:',
      wantText: 'unsupported value',
    },
    {
      name: 'unsupported escape',
      src: 'note = "a\\qb"',
      wantLine: 'line 1:',
      wantText: 'unsupported escape',
    },
    {
      // Go's strconv.ParseInt rejected this at the int64 boundary; the port
      // has to make the same call rather than silently rounding it.
      name: 'an integer too large for an int64',
      src: 'big = 9223372036854775808',
      wantLine: 'line 1:',
      wantText: 'unsupported value',
    },
  ];

  for (const tt of cases) {
    await t.test(tt.name, () => {
      let err: Error | null = null;
      try {
        parseTOML(tt.src);
      } catch (e) {
        err = e as Error;
      }
      assert.ok(err !== null, `parseTOML(${JSON.stringify(tt.src)}) should fail`);
      assert.ok(
        err.message.startsWith(tt.wantLine),
        `error does not start with ${tt.wantLine}: ${err.message}`,
      );
      assert.ok(
        err.message.includes(tt.wantText),
        `error does not mention ${tt.wantText}: ${err.message}`,
      );
    });
  }
});

/** repoRoot is the repository root, reached from this file rather than cwd. */
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** exampleFilePath is the config.example.toml the project ships. */
const exampleFilePath = path.join(repoRoot, 'config.example.toml');

/**
 * This pins the parser to the file the project ships, which is the only file
 * it has to be able to read.
 */
test('parseTOML reads config.example.toml', () => {
  const f = parseTOML(fs.readFileSync(exampleFilePath, 'utf8'));

  const want: { table: string; key: string; value: string }[] = [
    { table: '', key: 'provider', value: 'sqlite' },
    { table: 'sqlite', key: 'path', value: '~/.local/share/todocloud/tasks.db' },
    { table: 'turso', key: 'url', value: 'libsql://example.turso.io' },
    {
      table: 'd1',
      key: 'account_id',
      value: '00000000-0000-0000-0000-000000000000',
    },
    {
      table: 'd1',
      key: 'database_id',
      value: '00000000-0000-0000-0000-000000000000',
    },
  ];
  for (const w of want) {
    assert.equal(f.string(w.table, w.key), w.value, `${w.table}.${w.key}`);
  }

  // The example file must not carry a token key of its own.
  for (const e of f.entries) {
    assert.ok(
      !isTokenKey(e.key),
      `config.example.toml line ${e.value.line} sets a token-shaped key ${e.key}`,
    );
  }
});

// --- the fuzz target, as a seeded property test ------------------------
//
// The config file is untrusted input: it is hand-edited, generated by setup
// scripts and sometimes copied between machines. The parser is hand-written,
// so the invariant worth fuzzing is not what it returns but that a malformed
// file is always a located error and never a crash.
//
// `FuzzParseTOML` was a Go fuzz target: a corpus of `f.Add` seeds plus
// whatever the coverage-guided engine evolved from them. Node has no fuzzer,
// so this port keeps both halves of that in a form a unit-test run can
// execute:
//
//   - every seed the Go target added is an explicit case below, so the corpus
//     is not lost;
//   - the evolved inputs are replaced by generated ones, from a 32-bit
//     xorshift PRNG with a fixed seed. Determinism is the point: a failure
//     prints the input and the iteration, and the same run reproduces it,
//     which is what `testdata/fuzz` gave Go.
//
// The invariants are the Go target's, unchanged. What is gone is coverage
// guidance: these inputs are generated from a hostile grammar rather than
// evolved towards new branches, so this is a weaker instrument than a fuzzer
// and is not a reason to stop running one if the tree ever gains the means.

/** iterations is how many generated inputs the property test runs. */
const iterations = 4000;

/** prngSeed is fixed, so that a failure is reproducible to the iteration. */
const prngSeed = 0x5eed1234;

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

/**
 * hostileChars are the characters that decide a branch in the parser, plus
 * enough ordinary ones for a generated line to occasionally be valid. The
 * lone surrogate, the NUL and the invalid-UTF-8 replacement are deliberate:
 * the Go corpus carried the byte-level equivalents.
 */
const hostileChars = [
  '=',
  '[',
  ']',
  '{',
  '}',
  '"',
  "'",
  '\\',
  '#',
  '.',
  ',',
  ' ',
  '\t',
  '\r',
  '\n',
  '-',
  '+',
  '_',
  'a',
  'z',
  'A',
  '0',
  '9',
  'true',
  'false',
  'provider',
  'turso',
  '\u0000',
  'ÿ',
  '�',
  '\ud800',
  'é',
];

/** fragments are whole lines and line pieces, so a generated file sometimes parses. */
const fragments = [
  'provider = "sqlite"',
  'provider = sqlite',
  'provider =',
  'provider',
  '= "sqlite"',
  '[turso]',
  '[turso',
  '[[turso]]',
  '[a.b]',
  '[]',
  '[turso] junk',
  '# a comment',
  '',
  '   ',
  'url = "libsql://example.turso.io"',
  "url = 'unterminated",
  'url = "bad \\q escape"',
  'n = 1',
  'n = -1',
  'n = 9223372036854775808',
  'n = 1.5',
  'flag = true',
  'flag = false',
  'arr = [1, 2]',
  'tbl = { a = 1 }',
  'key = "a" trailing',
  'k\u0000ey = 1',
  'account_id = "00000000-0000-0000-0000-000000000000"',
  'token = "TOKEN_GOES_HERE"',
];

/**
 * validValues are the right-hand sides the subset accepts. A generated
 * document built only from these exercises the other half of the invariants —
 * the ones about an *accepted* document — which hostile input reaches far too
 * rarely on its own.
 */
const validValues = [
  '"sqlite"',
  "'turso'",
  '""',
  '"a\\tb\\nc"',
  '"libsql://example.turso.io/#fragment"',
  '0',
  '-1',
  '9223372036854775807',
  'true',
  'false',
  '42 # a trailing comment',
];

/** generateValid builds a document that should parse, with unique keys. */
function generateValid(rand: () => number): string {
  const lines = rand() % 8;
  const parts: string[] = [];
  for (let i = 0; i <= lines; i++) {
    const pick = rand() % 8;
    if (pick === 0) {
      parts.push('[t' + (rand() % 3) + ']');
      continue;
    }
    if (pick === 1) {
      parts.push(rand() % 2 === 0 ? '# comment' : '');
      continue;
    }
    // The key carries the line index, so no document duplicates a key — a
    // duplicate is a rejection, and this generator is for the accepted side.
    parts.push('k' + i + ' = ' + (validValues[rand() % validValues.length] ?? '0'));
  }
  return parts.join('\n') + (rand() % 2 === 0 ? '\n' : '');
}

/** generate builds one input from the PRNG. */
function generate(rand: () => number): string {
  // One in three is built to be valid; the rest are hostile.
  if (rand() % 3 === 0) {
    return generateValid(rand);
  }
  const lines = rand() % 6;
  const parts: string[] = [];
  for (let i = 0; i <= lines; i++) {
    if (rand() % 2 === 0) {
      parts.push(fragments[rand() % fragments.length] ?? '');
      continue;
    }
    // A run of hostile characters, which is where the parser's edges are.
    const runLength = rand() % 24;
    let s = '';
    for (let j = 0; j <= runLength; j++) {
      s += hostileChars[rand() % hostileChars.length] ?? '';
    }
    parts.push(s);
  }
  let src = parts.join('\n');
  if (rand() % 4 === 0) {
    src += '\n';
  }
  return src;
}

/**
 * seeds is every `f.Add` of the Go target, in its order, plus the shipped
 * example file, which the target added first as the canonical well-formed
 * document.
 */
function seeds(): string[] {
  return [
    fs.readFileSync(exampleFilePath, 'utf8'),

    '',
    '\n\n\n',
    '# just a comment\n',
    'provider = "sqlite"\n',
    '[turso]\nurl = "libsql://example.turso.io"\ntoken = "TOKEN_GOES_HERE"\n',
    '[d1]\naccount_id = "00000000-0000-0000-0000-000000000000"\n',

    // Malformed lines.
    'provider',
    '= "sqlite"',
    'provider =',
    'pro vider = 1',
    'provider = sqlite',
    'provider = "a" trailing',
    'provider = 1 # ok\nprovider = 2\n',

    // Unterminated and oddly escaped strings.
    'url = "libsql://example.turso.io',
    "url = 'unterminated",
    'url = "bad \\q escape"',
    'url = "trailing backslash \\',

    // Table headers.
    '[turso',
    '[turso.nested]\nurl = "x"\n',
    '[[array]]\nurl = "x"\n',
    '[[[[',
    '[]\nkey = 1\n',
    '[turso] junk\n',
    '[turso] # fine\n',

    // Values the subset rejects.
    'ports = [1, 2, 3]\n',
    'inline = { a = 1 }\n',
    'big = 9223372036854775808\n',
    'neg = -1\n',
    'flag = true\nother = false\n',

    // Byte-level hostility. Go's corpus held raw bytes; the equivalents here
    // are the characters those bytes decode to, plus a lone surrogate, which
    // is the closest a JS string comes to invalid UTF-8.
    'provider = "sql\u0000ite"\n',
    'provider\u0000 = 1\n',
    '﻿provider = "sqlite"\n',
    'provider = "sqlite"\r\n[turso]\r\nurl = "x"\r\n',
    'provider = "𐀀 invalid utf-8"\n',
    'provider = "�� invalid utf-8"\n',
    '\ud800 = 1\n',
    '�� = 1\n',
    'key = ' + 'a'.repeat(4096) + '\n',
    '# '.repeat(5000) + '\nprovider = "sqlite"\n',
    '[a]\nk = 1\n'.repeat(200),
  ];
}

/**
 * checkInvariants is `f.Fuzz`'s body: either a located rejection, or a
 * document that is self-consistent with its own accessors.
 */
function checkInvariants(src: string, where: string): void {
  let file;
  try {
    file = parseTOML(src);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Every rejection has to tell the user which line is wrong.
    assert.ok(
      msg.startsWith('line '),
      `${where}: error does not start with a line number: ${msg}`,
    );
    const m = /^line (\d+):/u.exec(msg);
    assert.ok(m !== null, `${where}: error does not name a line: ${msg}`);
    const line = Number(m[1]);
    assert.ok(line >= 1, `${where}: error names line ${line}: ${msg}`);
    const got = src.split('\n').length;
    assert.ok(
      line <= got,
      `${where}: error names line ${line} but the input has ${got} line(s): ${msg}`,
    );
    return;
  }

  // An accepted document must be self-consistent: every entry has a bare key,
  // a one-level table and a known kind, and the accessors must agree with it.
  for (const e of file.entries) {
    assert.equal(
      checkBareKey(e.key, e.value.line),
      null,
      `${where}: accepted an invalid key ${JSON.stringify(e.key)}`,
    );
    if (e.table !== '') {
      assert.equal(
        checkBareKey(e.table, e.value.line),
        null,
        `${where}: accepted an invalid table name ${JSON.stringify(e.table)}`,
      );
    }
    assert.ok(
      e.value.kind === kindString ||
        e.value.kind === kindInt ||
        e.value.kind === kindBool,
      `${where}: entry ${e.table}.${e.key} has an unknown kind ${e.value.kind}`,
    );
    const looked = file.lookup(e.table, e.key);
    assert.ok(
      looked !== undefined && looked.kind === e.value.kind,
      `${where}: lookup disagrees with the entry list for ${e.table}.${e.key}`,
    );
    if (e.value.kind === kindString) {
      assert.ok(
        file.string(e.table, e.key) !== undefined,
        `${where}: string accessor lost ${e.table}.${e.key}`,
      );
    }
  }
}

test('parseTOML: every fuzz seed is a located rejection or a consistent document', () => {
  for (const [i, src] of seeds().entries()) {
    checkInvariants(src, `seed ${i} ${JSON.stringify(src.slice(0, 60))}`);
  }
});

test(`parseTOML: ${iterations} generated inputs hold the same invariants`, () => {
  const rand = xorshift32(prngSeed);
  for (let i = 0; i < iterations; i++) {
    const src = generate(rand);
    checkInvariants(src, `iteration ${i} ${JSON.stringify(src)}`);
  }
});
