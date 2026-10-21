import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import {
  childError,
  databaseFromURL,
  ExitError,
  installRunner,
  matchDatabaseInURL,
  resetRunner,
  SOURCE_STDIN,
  SOURCE_TURSO_CLI,
  TURSO_BIN,
  trimOneNewline,
  tursoAvailable,
  tursoCreateToken,
  tursoDatabaseURL,
  tursoDatabases,
  tursoLoggedIn,
  validateDatabaseName,
  type Output,
  type Runner,
} from './providercli.ts';
import { REDACTED, Secret } from './secret.ts';

// The value every test here mints. No test may ever see it in an error, a
// formatted value or a JSON document. It is an obvious placeholder, never a
// realistic-looking token (CLAUDE.md §1.3).
const fakeToken = 'TOKEN_GOES_HERE_turso';

/**
 * Replaces both process indirections, so that no test in this file can reach
 * a real provider CLI, and returns the argv of every command that was run.
 *
 * `node:test` has no t.Cleanup that survives an async assertion failure in
 * the way Go's does, so every test installs at the top and resets in a
 * `finally`; `withRunner` wraps that.
 */
function installFake(present: boolean, fn: Runner | null): string[][] {
  const calls: string[][] = [];
  installRunner({
    lookPath: (file) => {
      if (!present) {
        throw new Error(`executable file not found in $PATH: ${file}`);
      }
      return '/fake/bin/' + file;
    },
    runner: (signal, name, args) => {
      calls.push([name, ...args]);
      if (fn === null) {
        return { stdout: '', stderr: '' };
      }
      return fn(signal, name, args);
    },
  });
  return calls;
}

/** Runs body with a fake runner installed, and always uninstalls it. */
async function withRunner(
  present: boolean,
  fn: Runner | null,
  body: (calls: string[][]) => void | Promise<void>,
): Promise<void> {
  const calls = installFake(present, fn);
  try {
    await body(calls);
  } finally {
    resetRunner();
  }
}

/** A runner that never returns until the deadline aborts it. */
const hangs: Runner = (signal) =>
  new Promise<Output>((resolve) => {
    if (signal.aborted) {
      resolve({ stdout: '', stderr: '', err: new Error('aborted') });
      return;
    }
    signal.addEventListener('abort', () =>
      resolve({ stdout: '', stderr: '', err: new Error('aborted') }),
    );
  });

/** The message of whatever a promise rejected with. */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail('expected a rejection');
}

test('the token source names are the documented --json values', () => {
  assert.equal(SOURCE_TURSO_CLI, 'turso-cli');
  assert.equal(SOURCE_STDIN, 'stdin');
  assert.equal(TURSO_BIN, 'turso');
});

test('databaseFromURL', () => {
  const cases: [name: string, url: string, want: string, ok: boolean][] = [
    ['plain libsql url', 'libsql://my-tasks-myname.turso.io', 'my-tasks', true],
    ['https url', 'https://todo-acme.turso.io', 'todo', true],
    ['with a path', 'libsql://todo-acme.turso.io/', 'todo', true],
    ['with a port', 'libsql://todo-acme.turso.io:443', 'todo', true],
    ['uppercase host', 'libsql://TODO-ACME.turso.io', 'todo', true],
    ['no scheme', 'todo-acme.turso.io', 'todo', true],
    ['several dashes keeps all but the last', 'libsql://a-b-c-org.turso.io', 'a-b-c', true],
    ['no dash is uncertain', 'libsql://todo.turso.io', '', false],
    ['trailing dash is uncertain', 'libsql://todo-.turso.io', '', false],
    ['leading dash is uncertain', 'libsql://-org.turso.io', '', false],
    ['not a turso host', 'libsql://todo-acme.example.com', '', false],
    ['extra label', 'libsql://a.todo-acme.turso.io', '', false],
    ['empty', '', '', false],
    ['only the suffix', 'libsql://.turso.io', '', false],
  ];
  for (const [name, url, want, ok] of cases) {
    assert.deepEqual(databaseFromURL(url), [want, ok], name);
  }
});

test('matchDatabaseInURL', () => {
  const cases: [
    name: string,
    url: string,
    databases: string[] | null,
    want: string,
    ok: boolean,
  ][] = [
    ['exact label', 'libsql://todo.turso.io', ['todo', 'other'], 'todo', true],
    ['name plus organization', 'libsql://my-tasks-acme.turso.io', ['my-tasks'], 'my-tasks', true],
    ['longest name wins', 'libsql://my-tasks-acme.turso.io', ['my', 'my-tasks'], 'my-tasks', true],
    ['no match', 'libsql://todo-acme.turso.io', ['notes', 'other'], '', false],
    ['empty list', 'libsql://todo-acme.turso.io', null, '', false],
    ['not a turso host', 'libsql://todo-acme.example.com', ['todo'], '', false],
    ['empty names ignored', 'libsql://todo.turso.io', ['', 'todo'], 'todo', true],
  ];
  for (const [name, url, databases, want, ok] of cases) {
    assert.deepEqual(matchDatabaseInURL(url, databases), [want, ok], name);
  }
});

test('tursoAvailable', async () => {
  await withRunner(false, null, () => {
    assert.equal(tursoAvailable(), false, 'reported an absent binary as present');
  });
  await withRunner(true, null, () => {
    assert.equal(tursoAvailable(), true, 'reported a present binary as absent');
  });
});

// The point of the function: `turso auth token` prints a credential, so its
// stdout must not be read, returned or placed in an error.
test('tursoLoggedIn reads only the exit status', async () => {
  await withRunner(true, () => ({ stdout: fakeToken + '\n', stderr: '' }), async (calls) => {
    assert.equal(await tursoLoggedIn(), true, 'a zero exit status should mean logged in');
    assert.deepEqual(calls, [['turso', 'auth', 'token']]);
  });
});

test('tursoLoggedIn treats a non-zero exit as not logged in', async () => {
  await withRunner(
    true,
    () => ({ stdout: fakeToken, stderr: 'not logged in', err: new ExitError(1) }),
    async () => {
      assert.equal(await tursoLoggedIn(), false, 'a non-zero exit status should mean not logged in');
    },
  );
});

// The failure path, where a careless implementation would quote the child's
// output.
test('tursoLoggedIn never puts stdout in its error', async () => {
  await withRunner(
    true,
    () => ({
      stdout: fakeToken,
      stderr: 'turso: something went wrong',
      err: new Error('exec: signal: killed'),
    }),
    async () => {
      const message = await rejection(tursoLoggedIn());
      assert.ok(!message.includes(fakeToken), `the child's stdout reached the error: ${message}`);
      assert.ok(
        message.includes('something went wrong'),
        `the error drops the child's stderr: ${message}`,
      );
    },
  );
});

test('tursoLoggedIn without the binary', async () => {
  await withRunner(
    false,
    () => assert.fail('no command may run when the binary is absent'),
    async () => {
      const message = await rejection(tursoLoggedIn());
      assert.ok(message.includes('is not installed'), message);
    },
  );
});

test('tursoLoggedIn reports a timeout', async () => {
  await withRunner(true, hangs, async () => {
    // The real timeout is ten seconds; shorten it so the test is fast.
    // resetRunner puts it back when withRunner returns.
    installRunner({ commandTimeoutMs: 20 });
    const message = await rejection(tursoLoggedIn());
    assert.ok(
      message.includes('did not finish within'),
      `the error does not name the timeout: ${message}`,
    );
  });
});

test('tursoDatabases parses the table', async () => {
  await withRunner(
    true,
    () => ({
      stdout:
        'NAME      GROUP     URL\n' +
        'my-tasks  default   libsql://my-tasks-acme.turso.io\n' +
        'notes     default   libsql://notes-acme.turso.io\n\n',
      stderr: '',
    }),
    async () => {
      assert.deepEqual(await tursoDatabases(), ['my-tasks', 'notes']);
    },
  );
});

test('tursoDatabases with empty output', async () => {
  await withRunner(true, null, async () => {
    assert.deepEqual(await tursoDatabases(), []);
  });
});

test('tursoDatabases reports a failure', async () => {
  await withRunner(
    true,
    () => ({ stdout: fakeToken, stderr: 'not logged in', err: new ExitError(2) }),
    async () => {
      const message = await rejection(tursoDatabases());
      assert.ok(message.includes('status 2'), `the error does not report the exit status: ${message}`);
      assert.ok(!message.includes(fakeToken), `the child's stdout reached the error: ${message}`);
    },
  );
});

test('tursoCreateToken returns a secret', async () => {
  await withRunner(true, () => ({ stdout: fakeToken + '\n', stderr: '' }), async (calls) => {
    const token = await tursoCreateToken('my-tasks');
    assert.equal(token.reveal(), fakeToken, 'the token was altered');
    assert.deepEqual(calls, [['turso', 'db', 'tokens', 'create', 'my-tasks']]);

    // The whole reason this is a Secret: no rendering path discloses it.
    const rendered = [
      String(token),
      `${token}`,
      token + '',
      inspect(token),
      inspect({ token }),
      JSON.stringify({ token }),
      JSON.stringify([token]),
    ];
    for (const s of rendered) {
      assert.ok(!s.includes(fakeToken), `a rendering disclosed the token: ${s}`);
    }
  });
});

test('tursoCreateToken trims exactly one newline', async () => {
  await withRunner(true, () => ({ stdout: fakeToken + '\n\n', stderr: '' }), async () => {
    const token = await tursoCreateToken('db');
    assert.equal(token.reveal(), fakeToken + '\n', 'more than one line ending was trimmed');
  });
});

test('trimOneNewline removes one terminator and nothing else', () => {
  assert.equal(trimOneNewline('x\r\n'), 'x');
  assert.equal(trimOneNewline('x\n\n'), 'x\n');
  assert.equal(trimOneNewline('x'), 'x');
  assert.equal(trimOneNewline('x \t'), 'x \t');
  assert.equal(trimOneNewline(''), '');
});

test('tursoCreateToken with empty output', async () => {
  await withRunner(true, null, async () => {
    const message = await rejection(tursoCreateToken('db'));
    assert.ok(message.includes('printed no token'), message);
  });
});

// Covers a CLI that echoes what it printed into its diagnostics.
test('tursoCreateToken scrubs its own token from stderr', async () => {
  await withRunner(
    true,
    () => ({
      stdout: fakeToken + '\n',
      stderr: 'failed after printing ' + fakeToken,
      err: new ExitError(1),
    }),
    async () => {
      const message = await rejection(tursoCreateToken('db'));
      assert.ok(!message.includes(fakeToken), `the token survived into the error: ${message}`);
      assert.ok(message.includes(REDACTED), `the error should show it was redacted: ${message}`);
    },
  );
});

test('tursoCreateToken reports a timeout', async () => {
  await withRunner(true, hangs, async () => {
    installRunner({ commandTimeoutMs: 20 });
    const message = await rejection(tursoCreateToken('db'));
    assert.ok(message.includes('did not finish within'), message);
  });
});

test('tursoCreateToken refuses a flag-shaped name', async () => {
  await withRunner(
    true,
    () => assert.fail('a rejected name must not reach a child process'),
    async () => {
      for (const name of ['', '--help', 'a b', 'a;rm -rf /']) {
        await assert.rejects(tursoCreateToken(name), `name ${JSON.stringify(name)} was accepted`);
      }
    },
  );
});

test('a rejected name is quoted in the error, so a control character is visible', () => {
  assert.throws(() => validateDatabaseName('a\u0000b'), /invalid database name "a\\u0000b"/);
  assert.throws(() => validateDatabaseName('-x'), /must not start with a dash/);
  assert.throws(() => validateDatabaseName(''), /no database name given/);
  // The accepted shape.
  validateDatabaseName('my_tasks-1');
});

test('tursoDatabaseURL', async () => {
  await withRunner(
    true,
    () => ({ stdout: 'libsql://my-tasks-acme.turso.io\n', stderr: '' }),
    async (calls) => {
      assert.equal(await tursoDatabaseURL('my-tasks'), 'libsql://my-tasks-acme.turso.io');
      assert.deepEqual(calls, [['turso', 'db', 'show', 'my-tasks', '--url']]);
    },
  );
});

test('tursoDatabaseURL failures', async () => {
  await withRunner(
    true,
    () => ({ stdout: '', stderr: 'no such database', err: new ExitError(1) }),
    async () => {
      const message = await rejection(tursoDatabaseURL('nope'));
      assert.ok(message.includes('status 1'), message);
      assert.ok(message.includes('no such database'), message);
    },
  );
  await withRunner(true, null, async () => {
    const message = await rejection(tursoDatabaseURL('db'));
    assert.ok(message.includes('printed no url'), message);
  });
});

// The Go test drove a real #!/bin/sh child through execRunner. There is no
// execRunner here: spawning a process needs `node:child_process`, which this
// package may not import, so `packages/cli` owns the real runner and its
// test. What remains to cover on this side is the one function that turns an
// Output into an error, which is the only path a token could escape through.
test('childError reports the status and never the stdout', () => {
  const out: Output = {
    stdout: fakeToken + '\n',
    stderr: 'a note\n',
    err: new ExitError(7),
  };
  // The caller always drops stdout before building the error; this asserts
  // childError would not disclose it even if one forgot.
  const err = childError('fake-turso', out);
  assert.ok(!err.message.includes(fakeToken), `the token reached the error: ${err.message}`);
  assert.ok(
    err.message.includes('status 7'),
    `the error does not report the exit status: ${err.message}`,
  );
  assert.equal(childError('t', { stdout: '', stderr: '', err: new ExitError(3) }).message,
    't exited with status 3');
  assert.equal(childError('t', { stdout: '', stderr: ' boom ', err: new Error('killed') }).message,
    't: killed: boom');
  assert.equal(childError('t', { stdout: '', stderr: '', err: new Error('killed') }).message,
    't: killed');
});

test('a Secret built from a child mint is unprintable', () => {
  // Guards the one assumption this module makes about ./secret.ts.
  assert.equal(String(new Secret(fakeToken)), REDACTED);
  assert.equal(new Secret('').empty(), true);
});

test('with no runner installed, nothing is reported as available and nothing runs', async () => {
  resetRunner();
  assert.equal(tursoAvailable(), false);
  const message = await rejection(tursoLoggedIn());
  assert.ok(message.includes('is not installed'), message);
});

// ---------------------------------------------------------------------------
// The port of FuzzDatabaseFromURL.
// ---------------------------------------------------------------------------

// A Turso URL comes from the user's config file or from the provider CLI's
// output, and the name read out of it is offered to commands that put it on a
// child process's argv. What is asserted here is what the function actually
// guarantees: a certain answer is non-empty, lower-cased, and carries none of
// the delimiters the host is actually split on: the scheme separator, a path,
// query or fragment, and userinfo. A colon or a space can survive, because
// only the LAST colon is read as a port and whitespace is trimmed only at the
// ends.
//
// It is deliberately NOT asserted that the name passes validateDatabaseName
// for every input — only for those reported as certain, which is the stronger
// property the Go tree states separately in
// TestDatabaseFromURLOnlyReportsNamesItsOwnCommandsAccept below.
//
// Node has no built-in fuzzer, so the Go fuzz target is ported as a property
// test: a seeded 32-bit xorshift drives the generator, so a failure is
// reproducible from the seed printed in the message rather than from a corpus
// file this repo would have to carry.
function invariants(url: string): void {
  // The first invariant of any fuzz target: it must not panic. A throw from
  // databaseFromURL propagates out of the test and fails it.
  const [name, ok] = databaseFromURL(url);
  if (!ok) {
    assert.equal(
      name,
      '',
      `databaseFromURL(${JSON.stringify(url)}) reported an uncertain answer but returned ${JSON.stringify(name)}`,
    );
    return;
  }
  assert.notEqual(
    name,
    '',
    `databaseFromURL(${JSON.stringify(url)}) returned an empty name as certain`,
  );
  const delimiter = /[./?#@]/.exec(name);
  assert.equal(
    delimiter,
    null,
    `databaseFromURL(${JSON.stringify(url)}) = ${JSON.stringify(name)}, which holds a delimiter`,
  );
  assert.equal(
    name.toLowerCase(),
    name,
    `databaseFromURL(${JSON.stringify(url)}) = ${JSON.stringify(name)}, which was not lower-cased`,
  );
}

// The Go seed corpus, verbatim. `testdata/fuzz` holds no saved corpus entries
// in this repo, so these f.Add seeds are the whole of it.
const seeds: string[] = [
  '',
  ' ',
  'libsql://example.turso.io',
  'libsql://tasks-acme.turso.io',
  'https://tasks-acme.turso.io/v2/pipeline?x=1#frag',
  'libsql://user:pass@tasks-acme.turso.io:443/db',
  'LIBSQL://TASKS-ACME.TURSO.IO',
  'tasks-acme.turso.io',
  'tasks-with-many-dashes-acme.turso.io',
  '-acme.turso.io',
  'tasks-.turso.io',
  '-.turso.io',
  '--.turso.io',
  '--0.turso.io',
  '-x-y.turso.io',
  'libsql://tasks x-acme.turso.io',
  ':-0.turso.io:',
  '.turso.io',
  'a.b-c.turso.io',
  'turso.io',
  'example.com',
  'libsql://tasks-acme.turso.io.evil.com',
  'libsql://tasks-acme.TURSO.io',
  'libsql://' + 'a-'.repeat(200) + 'b.turso.io',
  'libsql://tasks-acme.turso.io:notaport',
  'libsql://tasks\u0000-acme.turso.io',
  // Go's "\xff\xfe" is not valid UTF-8 and has no exact string equivalent in
  // JS, whose strings are UTF-16. The two bytes are carried as the code
  // points U+00FF U+00FE, which exercises the same branch: a label holding
  // non-ASCII that validateDatabaseName must refuse.
  'libsql://tasks-ÿþ.turso.io',
  'libsql://tasks-acme.turso.io/#@evil.turso.io',
  '://tasks-acme.turso.io',
  'libsql://@tasks-acme.turso.io',
];

test('databaseFromURL holds its invariants over the seed corpus', () => {
  for (const seed of seeds) {
    invariants(seed);
  }
});

/**
 * A 32-bit xorshift. Written out rather than taken from `Math.random` so
 * that a failing run is reproducible: the same seed replays the same inputs.
 */
function xorshift32(seed: number): () => number {
  let state = seed | 0 || 0x2545f491;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    // Returned unsigned, so a caller can take a modulus without sign
    // surprises.
    return state >>> 0;
  };
}

// The pieces a generated input is assembled from. They are the bytes
// tursoHostLabel actually branches on, plus the shapes a real URL has, so
// that random assembly reaches the interesting states far more often than
// uniform random characters would.
const chunks: string[] = [
  'libsql://',
  'https://',
  '://',
  '//',
  ':',
  '/',
  '?',
  '#',
  '@',
  '.',
  '-',
  '_',
  ' ',
  '\t',
  '\n',
  '\u0000',
  'ÿ',
  'テ', // a non-ASCII letter: a label a name may not be sliced out of
  '😀', // an astral code point, as a surrogate pair
  '\ud800', // a lone surrogate, which no well-formed string has
  'turso.io',
  '.turso.io',
  'TURSO.IO',
  'tasks',
  'acme',
  'a',
  'B',
  '0',
  'user:pass',
  '443',
  'v2/pipeline',
  'example.com',
];

const generatedCases = 5000;

test(`databaseFromURL holds its invariants over ${generatedCases} generated inputs`, () => {
  const next = xorshift32(0x5eed1234);
  for (let i = 0; i < generatedCases; i++) {
    // A mutation of a seed as often as a fresh assembly: starting from a
    // valid URL and perturbing it reaches the "nearly right" inputs that a
    // purely random assembly almost never produces.
    const seed = seeds[next() % seeds.length] ?? '';
    const parts: string[] = next() % 2 === 0 ? [seed] : [];
    const count = next() % 8;
    for (let j = 0; j < count; j++) {
      const chunk = chunks[next() % chunks.length] ?? '';
      if (parts.length > 0 && next() % 4 === 0) {
        // Splice into the middle rather than only appending.
        const at = next() % (parts.length + 1);
        parts.splice(at, 0, chunk);
      } else {
        parts.push(chunk);
      }
    }
    const url = parts.join('');
    try {
      invariants(url);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      assert.fail(`case ${i} (seed 0x5eed1234), input ${JSON.stringify(url)}: ${detail}`);
    }
  }
});

test('the generator is deterministic, so a failure replays', () => {
  const a = xorshift32(1);
  const b = xorshift32(1);
  const first = [a(), a(), a()];
  assert.deepEqual([b(), b(), b()], first);
  // A zero seed would stick at zero, so it is replaced by a fixed constant.
  assert.notEqual(xorshift32(0)(), 0);
});

// A name sliced out of a host label is only reported as certain when it is a
// name this module would also accept as an argument. Anything else — a NUL
// byte, whitespace, a flag-shaped leading dash — is reported as uncertain, so
// the caller falls back to `turso db list` or asks for --database instead of
// carrying a value that the next call refuses.
test('databaseFromURL only reports names its own commands accept', () => {
  const uncertain = [
    'libsql://tasks\u0000-acme.turso.io', // a NUL byte in the host label
    '--0.turso.io', // a name a child would read as a flag
    'libsql://tasks x-acme.turso.io', // whitespace inside the label
    ':-0.turso.io:', // a colon that is not the last one
  ];
  for (const url of uncertain) {
    const [name, ok] = databaseFromURL(url);
    assert.equal(ok, false, `databaseFromURL(${JSON.stringify(url)}) = ${name}, want uncertain`);
  }

  // Whatever it does report has to survive the validation every command
  // applies, which is the property that makes "certain" mean something.
  for (const url of [
    'libsql://tasks-acme.turso.io',
    'libsql://my_tasks-acme.turso.io',
    'libsql://my-tasks-acme.turso.io',
  ]) {
    const [name, ok] = databaseFromURL(url);
    assert.equal(ok, true, `databaseFromURL(${JSON.stringify(url)}) is uncertain, want a name`);
    validateDatabaseName(name);
  }
});

// Every generated and seeded input also goes through matchDatabaseInURL,
// which shares tursoHostLabel: a name it reports must be one of the names it
// was given, and so must already be valid.
test('matchDatabaseInURL only ever returns a name it was given', () => {
  const known = ['tasks', 'tasks-acme', 'a', 'example', '', '--bad', 'a b'];
  const next = xorshift32(0x0d15ea5e);
  for (let i = 0; i < generatedCases; i++) {
    const parts: string[] = [seeds[next() % seeds.length] ?? ''];
    const count = next() % 4;
    for (let j = 0; j < count; j++) {
      parts.push(chunks[next() % chunks.length] ?? '');
    }
    const url = parts.join('');
    const [name, ok] = matchDatabaseInURL(url, known);
    if (!ok) {
      assert.equal(name, '', `case ${i}: ${JSON.stringify(url)}`);
      continue;
    }
    assert.ok(known.includes(name), `case ${i}: ${JSON.stringify(url)} produced ${name}`);
    validateDatabaseName(name);
  }
});
