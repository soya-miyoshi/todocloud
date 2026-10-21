import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Ambiguous,
  classify,
  CodeAmbiguous,
  CodeConfig,
  CodeError,
  CodeNotFound,
  CodeProvider,
  CodeUsage,
  Config,
  configf,
  Error as ErrorCode,
  NotFound,
  OK,
  Provider,
  providerf,
  Usage,
  usagef,
} from './exit.ts';
import {
  ErrAmbiguous,
  ErrNotFound,
  ErrNotInitialized,
} from './store/store.ts';
import { ErrSchemaMismatch, VersionError } from './store/version.ts';
import { ErrInvalid, invalidf } from './taskops/edit.ts';

test('classify', () => {
  const tests: Array<{
    name: string;
    err: unknown;
    wantCode: number;
    wantJSON: string;
  }> = [
    { name: 'no error', err: null, wantCode: OK, wantJSON: '' },
    { name: 'undefined', err: undefined, wantCode: OK, wantJSON: '' },
    {
      name: 'plain error',
      err: new Error('boom'),
      wantCode: ErrorCode,
      wantJSON: CodeError,
    },
    {
      name: 'usage',
      err: usagef(new Error('bad flag')),
      wantCode: Usage,
      wantJSON: CodeUsage,
    },
    {
      name: 'config',
      err: configf(new Error('missing token')),
      wantCode: Config,
      wantJSON: CodeConfig,
    },
    {
      name: 'provider',
      err: providerf(new Error('timeout')),
      wantCode: Provider,
      wantJSON: CodeProvider,
    },
    {
      name: 'not found',
      err: ErrNotFound,
      wantCode: NotFound,
      wantJSON: CodeNotFound,
    },
    {
      name: 'ambiguous',
      err: ErrAmbiguous,
      wantCode: Ambiguous,
      wantJSON: CodeAmbiguous,
    },
    {
      name: 'uninitialized store is a config problem',
      err: ErrNotInitialized,
      wantCode: Config,
      wantJSON: CodeConfig,
    },
    {
      // A store at the wrong schema version is a config problem whichever way
      // it points, and a VersionError carries the sentinel as its cause.
      name: 'schema mismatch is a config problem',
      err: ErrSchemaMismatch,
      wantCode: Config,
      wantJSON: CodeConfig,
    },
    {
      name: 'a VersionError is a schema mismatch',
      err: new VersionError('a local file', 1, 2),
      wantCode: Config,
      wantJSON: CodeConfig,
    },
    {
      // A request the shared logic layer refused is the request's fault, not
      // the store's: exit 2, like any other usage error.
      name: 'a refused request is a usage error',
      err: ErrInvalid,
      wantCode: Usage,
      wantJSON: CodeUsage,
    },
    {
      // What taskops actually throws is invalidf's wrapper, with the sentinel
      // as its cause.
      name: 'an invalidf wrapper is a usage error',
      err: invalidf('priority must be between 0 and 3, got 9'),
      wantCode: Usage,
      wantJSON: CodeUsage,
    },
  ];
  for (const tc of tests) {
    assert.deepEqual(
      classify(tc.err),
      { code: tc.wantCode, jsonCode: tc.wantJSON },
      tc.name,
    );
  }
});

// Classification must survive the wrapping that happens as an error travels up
// through the store and the command layer.
test('classify through wrapping', () => {
  const tests: Array<{ name: string; err: unknown; want: number }> = [
    {
      name: 'wrapped usage error',
      err: new Error('add: bad value', { cause: usagef(new Error('bad value')) }),
      want: Usage,
    },
    {
      name: 'wrapped config error',
      err: new Error('load: no url', { cause: configf(new Error('no url')) }),
      want: Config,
    },
    {
      name: 'wrapped provider error',
      err: new Error('list: refused', {
        cause: providerf(new Error('refused')),
      }),
      want: Provider,
    },
    {
      name: 'wrapped sentinel',
      err: new Error('get task', { cause: ErrNotFound }),
      want: NotFound,
    },
    {
      name: 'doubly wrapped sentinel',
      err: new Error('outer', {
        cause: new Error('inner', { cause: ErrAmbiguous }),
      }),
      want: Ambiguous,
    },
    {
      name: 'doubly wrapped usage error',
      err: new Error('outer', {
        cause: new Error('inner', { cause: usagef(new Error('bad value')) }),
      }),
      want: Usage,
    },
  ];
  for (const tc of tests) {
    assert.equal(classify(tc.err).code, tc.want, tc.name);
  }
});

// classify tests the classes in a fixed order — usage, config, provider —
// so a chain carrying two of them lands on the first of the two whichever way
// it is nested, exactly as errors.As did in Go.
test('the class order is fixed, not the nesting order', () => {
  assert.equal(classify(providerf(usagef(new Error('bad value')))).code, Usage);
  assert.equal(classify(usagef(providerf(new Error('bad value')))).code, Usage);
});

// A cause cycle must not hang classify.
test('a cause cycle terminates', () => {
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  (a as { cause?: unknown }).cause = b;
  assert.equal(classify(b).code, ErrorCode);
});

// A sentinel takes precedence over the class a wrapper assigned, so a
// not-found that a provider wrapped still exits 5 rather than 4.
test('a sentinel wins over the wrapper class', () => {
  const err = providerf(new Error('query failed', { cause: ErrNotFound }));
  assert.equal(classify(err).code, NotFound);
});

// The refusal survives the wrapping it gets on the way out of the shared
// layer, which is the only form a front end ever sees it in.
test('a wrapped refusal is still a usage error', () => {
  const err = new Error('edit 01J3: invalid request: field "id" is reserved', {
    cause: invalidf('field "id" is reserved and cannot be set'),
  });
  assert.deepEqual(classify(err), { code: Usage, jsonCode: CodeUsage });
});

test('constructors pass through nil', () => {
  for (const [name, got] of Object.entries({
    usagef: usagef(null),
    configf: configf(null),
    providerf: providerf(null),
  })) {
    assert.equal(got, null, `${name}(null) must be null`);
  }
  assert.equal(usagef(undefined), null);
  assert.equal(configf(undefined), null);
  assert.equal(providerf(undefined), null);
});

// The message must survive classification: it is what the user and the JSON
// error envelope show.
test('wrappers keep the message', () => {
  for (const err of [
    usagef(new Error('bad flag')),
    configf(new Error('bad flag')),
    providerf(new Error('bad flag')),
  ]) {
    assert.equal(err?.message, 'bad flag');
  }
});

// The codes are a documented contract (docs/agents.md); changing one is a
// breaking change, so pin the numbers.
test('the codes are pinned', () => {
  const pinned: Array<[string, number, number]> = [
    ['OK', OK, 0],
    ['Error', ErrorCode, 1],
    ['Usage', Usage, 2],
    ['Config', Config, 3],
    ['Provider', Provider, 4],
    ['NotFound', NotFound, 5],
    ['Ambiguous', Ambiguous, 6],
  ];
  for (const [name, got, want] of pinned) {
    assert.equal(
      got,
      want,
      `${name} = ${got}, want ${want}: exit codes are part of the documented contract`,
    );
  }
});

// The JSON error codes are part of the same contract.
test('the JSON error codes are pinned', () => {
  assert.equal(CodeError, 'error');
  assert.equal(CodeUsage, 'usage');
  assert.equal(CodeConfig, 'config');
  assert.equal(CodeProvider, 'provider');
  assert.equal(CodeNotFound, 'not_found');
  assert.equal(CodeAmbiguous, 'ambiguous_id');
});
