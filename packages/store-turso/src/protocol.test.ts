import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endpointFor, decodePipelineResponse } from './client.ts';
import {
  Value,
  clip,
  encodeArg,
  kindFloat,
  kindInteger,
  newStatement,
  parseWire,
  valueFromJSON,
  kindBlob,
  kindNull,
  kindText,
} from './protocol.ts';
import { exampleURL, testToken } from './fakeserver.test.ts';

const maxInt64 = 9223372036854775807n;
const minInt64 = -9223372036854775808n;

/** roundTrip sends a value through the wire form and reads it back. */
function roundTrip(v: Value): { encoded: string; back: Value } {
  const encoded = JSON.stringify(v);
  return { encoded, back: valueFromJSON(parseWire(encoded)) };
}

// An integer travels as a decimal string. The whole point of that is the
// int64 edges: a decoder that went through a double would turn
// 9223372036854775807 into 9223372036854775808, and the project's rule is
// that any whole number fitting in an int64 survives a round trip.
test('integer values round trip at the int64 edges', () => {
  for (const n of [0n, 1n, -1n, maxInt64, minInt64, 9007199254740993n]) {
    const { encoded, back } = roundTrip(new Value(kindInteger, n));
    // The wire form is a string, not a JSON number.
    assert.ok(
      encoded.includes('"value":"'),
      `${n} was sent as ${encoded}, want the decimal-string form`,
    );
    assert.equal(back.int64(), n, `${n} round-tripped to ${String(back.any)}`);
  }
});

// A server that sends a bare JSON integer instead of the string form is
// still understood, and still not routed through a double.
test('an integer value accepts a bare JSON number', () => {
  const v = valueFromJSON(
    parseWire('{"type":"integer","value":9223372036854775807}'),
  );
  assert.equal(v.int64(), maxInt64);
});

test('value kinds round trip', () => {
  const cases: { name: string; in: Value; want: unknown }[] = [
    { name: 'null', in: new Value(kindNull), want: null },
    {
      name: 'text',
      in: new Value(kindText, 'hello \u0000 world'),
      want: 'hello \u0000 world',
    },
    { name: 'float', in: new Value(kindFloat, 1.5), want: 1.5 },
    {
      name: 'blob',
      in: new Value(kindBlob, new Uint8Array([0, 1, 2, 255])),
      want: new Uint8Array([0, 1, 2, 255]),
    },
  ];
  for (const tc of cases) {
    const { back } = roundTrip(tc.in);
    if (tc.want === null) {
      assert.ok(back.isNull(), `${tc.name}: got ${String(back.any)}, want null`);
      continue;
    }
    if (tc.want instanceof Uint8Array) {
      assert.deepEqual(back.any, tc.want, tc.name);
      continue;
    }
    assert.equal(back.any, tc.want, tc.name);
  }
});

// A malformed value is an error, never a silently empty column: a task whose
// title decoded to "" would look like a real task with no title.
test('malformed values are refused', () => {
  for (const raw of [
    '{"type":"integer","value":"not a number"}',
    '{"type":"integer"}',
    '{"type":"float","value":"nope"}',
    '{"type":"text","value":7}',
    '{"type":"blob","base64":"!!!!"}',
    '{"type":"wat","value":"x"}',
    '{"value":"x"}',
    '"bare string"',
    '7',
  ]) {
    assert.throws(
      () => valueFromJSON(parseWire(raw)),
      `valueFromJSON(${raw}) succeeded, want an error`,
    );
  }
});

// An integer outside the int64 range is malformed too: it is a value no
// SQLite column can have held, so accepting it would mean inventing one.
test('an out-of-range integer is refused', () => {
  assert.throws(() =>
    valueFromJSON(parseWire('{"type":"integer","value":"9223372036854775808"}')),
  );
});

// Binding only accepts the types this package actually sends, so a new call
// site that passes something else fails loudly instead of sending a surprise.
test('encodeArg rejects unknown types', () => {
  assert.throws(() => encodeArg({ a: 1 }), 'encodeArg accepted an object');
  assert.throws(() => encodeArg(new Map()), 'encodeArg accepted a Map');
  assert.throws(
    () => newStatement('SELECT 1', true, { a: 'b' }),
    'newStatement accepted an object argument',
  );
});

// A whole float binds as an integer, which is the same rule
// Fields.normalize applies, so a value has one type on both sides of a
// round trip.
test('encodeArg intifies whole numbers', () => {
  assert.equal(encodeArg(3.0).kind, kindInteger);
  assert.equal(encodeArg(3.5).kind, kindFloat);
  // A whole number too large for an int64 is a float, not a rounded integer.
  assert.equal(encodeArg(1e300).kind, kindFloat);
});

// A float the wire cannot carry is refused on the way out rather than sent as
// something else.
test('a non-finite float cannot be sent', () => {
  assert.throws(() => JSON.stringify(new Value(kindFloat, Number.NaN)));
  assert.throws(() => JSON.stringify(new Value(kindFloat, Number.POSITIVE_INFINITY)));
});

// A blob arrives in either alphabet, since servers differ on which they emit.
test('a blob is read from the padded and the unpadded alphabet', () => {
  for (const raw of ['aGk', 'aGk=']) {
    const v = valueFromJSON(parseWire(`{"type":"blob","base64":"${raw}"}`));
    assert.deepEqual(v.any, new Uint8Array([0x68, 0x69]));
  }
});

// The endpoint is derived, never configured. libsql:// is https://, and a URL
// that would carry a credential is refused outright.
test('endpointFor derives the pipeline endpoint', () => {
  const cases: { name: string; in: string; want: string }[] = [
    {
      name: 'libsql becomes https',
      in: exampleURL,
      want: 'https://example.turso.io/v2/pipeline',
    },
    {
      name: 'https is accepted as given',
      in: 'https://example.turso.io',
      want: 'https://example.turso.io/v2/pipeline',
    },
    {
      name: 'http reaches a self-hosted sqld',
      in: 'http://127.0.0.1:8080',
      want: 'http://127.0.0.1:8080/v2/pipeline',
    },
    {
      name: 'a trailing slash is not doubled',
      in: 'libsql://example.turso.io/',
      want: 'https://example.turso.io/v2/pipeline',
    },
    {
      name: 'surrounding whitespace is ignored',
      in: '  ' + exampleURL + '\n',
      want: 'https://example.turso.io/v2/pipeline',
    },
  ];
  for (const tc of cases) {
    assert.equal(endpointFor(tc.in).endpoint, tc.want, tc.name);
  }
});

test('endpointFor refuses URLs that could carry a credential', () => {
  const cases: { name: string; in: string }[] = [
    { name: 'empty', in: '' },
    { name: 'no scheme', in: 'example.turso.io' },
    { name: 'unsupported scheme', in: 'ftp://example.turso.io' },
    { name: 'no host', in: 'libsql://' },
    { name: 'userinfo', in: 'libsql://user:TOKEN_GOES_HERE@example.turso.io' },
    {
      name: 'query string',
      in: 'libsql://example.turso.io?authToken=TOKEN_GOES_HERE',
    },
    { name: 'empty query string', in: 'libsql://example.turso.io?' },
    { name: 'fragment', in: 'libsql://example.turso.io#TOKEN_GOES_HERE' },
  ];
  for (const tc of cases) {
    let thrown: unknown;
    assert.throws(
      () => endpointFor(tc.in),
      (err: unknown) => {
        thrown = err;
        return true;
      },
      `${tc.name}: endpointFor(${tc.in}) succeeded, want an error`,
    );
    // The refusal explains the problem without echoing the value
    // that might have been a token.
    assert.ok(
      !(thrown as Error).message.includes(testToken),
      `${tc.name}: the refusal quotes the credential: ${(thrown as Error).message}`,
    );
  }
});

// clip is what bounds untrusted server text on its way into an error. It must
// shorten, strip control characters and quote.
test('clip bounds untrusted text', () => {
  const got = clip('x'.repeat(500));
  assert.ok(got.length <= 140, `clip returned ${got.length} bytes, want it bounded`);
  assert.ok(!clip('a\u0000b\nc').includes('\u0000'), 'clip kept a NUL');
});

// decodePipelineResponse is the only parser in this package that reads bytes
// the CLI did not write. Go fuzzed it; the property is the same either way:
// no input may produce a response that claims a value it cannot back up.
test('decodePipelineResponse refuses nothing it cannot back up', () => {
  const corpus = [
    '{"results":[{"type":"ok","response":{"type":"execute","result":{"cols":[{"name":"id"}],"rows":[[{"type":"text","value":"01J3"}]],"affected_row_count":0}}}]}',
    '{"results":[{"type":"error","error":{"message":"no such table: tasks","code":"SQLITE_UNKNOWN"}}]}',
    '{"results":[{"type":"ok","response":{"type":"execute","result":{"rows":[[{"type":"integer","value":"9223372036854775807"}]]}}}]}',
    '{"error":{"message":"stream expired"}}',
    '{"baton":"x","results":[]}',
    '{"results":[{"type":"ok","response":{"type":"execute","result":{"rows":[[{"type":"blob","base64":"aGk"}]]}}}]}',
    '',
    'null',
    '[]',
    '{"results":[[]]}',
    '{"results":{"a":1}}',
    '{"results":[{"type":"ok","response":{"type":"execute","result":{"rows":[7]}}}]}',
  ];
  for (const body of corpus) {
    let resp;
    try {
      resp = decodePipelineResponse(body);
    } catch {
      continue;
    }
    // Whatever came back must be self-consistent: every decoded value has a
    // kind the accessors understand, and the accessors answer without
    // throwing.
    for (const res of resp.results) {
      if (res.type === 'ok' && res.result !== undefined) {
        for (const row of res.result.rows) {
          for (const v of row) {
            assert.ok(
              [kindNull, kindInteger, kindFloat, kindText, kindBlob].includes(
                v.kind,
              ),
              `a decoded value has kind ${v.kind}`,
            );
            v.text();
            v.int64();
            v.isNull();
          }
        }
      }
    }
  }
});
