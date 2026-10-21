import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';

import { Config as ExitConfig, Provider as ExitProvider, classify } from '@todocloud/core/exit';
import { Secret } from '@todocloud/core/secret';
import { Filter } from '@todocloud/core/store/filter';

import { pipelinePath } from './client.ts';
import {
  idA,
  newFakeServer,
  newTestTask,
  openStore,
  testNow,
  testToken,
  tokenForTest,
} from './fakeserver.test.ts';
import { open, type Config } from './turso.ts';

/**
 * A bare HTTP server that answers every request with the given handler, for
 * the failure modes a SQLite-backed fake cannot produce. Go used
 * httptest.NewServer with the handler under test; this is the same thing on
 * `node:http`, listening on a port the OS picks.
 */
async function serveWith(
  t: TestContext,
  handler: (res: ServerResponse) => void,
): Promise<string> {
  const server: Server = createServer((_req, res) => handler(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not report a port');
  }
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
  });
  return `http://127.0.0.1:${address.port}`;
}

/** cfgFor is a Config pointed at a URL, with the placeholder token. */
function cfgFor(url: string, timeoutMs = 2_000): Config {
  return { url, token: tokenForTest(), timeoutMs };
}

// This package must only ever talk to the pipeline endpoint of the host it
// was configured with. It has no code that reaches Turso's platform API, so
// no command can create, rename or destroy a database — and this test is
// what keeps that true as the package grows: it exercises every method and
// asserts on every request that left.
test('every request goes to the pipeline endpoint and nowhere else', async (t) => {
  const { store: s, fake } = await openStore(t);

  // One of everything the Store interface offers.
  const ignore = async (p: Promise<unknown>): Promise<void> => {
    await p.catch(() => undefined);
  };
  await ignore(s.init());
  await ignore(s.migrate());
  await ignore(s.schemaVersion());
  await ignore(s.ping());
  await ignore(s.add(newTestTask(idA, 'a task')));
  await ignore(s.get(idA));
  await ignore(s.findByPrefix('01J3A'));
  await ignore(s.list(new Filter()));
  await ignore(s.update(newTestTask(idA, 'edited')));
  await ignore(s.move(idA, '', 1, testNow));
  await ignore(s.children(''));
  await ignore(s.subtree(idA));
  await ignore(s.availability(testNow, idA));
  await ignore(s.tags());
  await ignore(s.setTagStatus('home', 'on_hold', testNow));
  await ignore(s.renameTag('home', 'house', testNow));
  await ignore(s.removeTag('house'));
  await ignore(
    s.savePerspective({
      name: 'next',
      filter: new Filter(),
      createdAt: testNow,
      updatedAt: testNow,
    }),
  );
  await ignore(s.perspective('next'));
  await ignore(s.perspectives());
  await ignore(s.deletePerspective('next'));
  await ignore(s.purge(idA));
  await ignore(s.purgeSubtree(idA));

  const seen = fake.seen();
  assert.ok(
    seen.length >= 10,
    `only ${seen.length} request(s) were recorded; the test is not exercising the methods`,
  );
  for (const [i, req] of seen.entries()) {
    assert.equal(req.method, 'POST', `request ${i} used ${req.method}`);
    assert.equal(
      req.path,
      pipelinePath,
      `request ${i} went to ${req.path}; the only endpoint this package may use is ${pipelinePath}`,
    );
    assert.equal(
      req.rawQuery,
      '',
      `request ${i} carried a query string ${req.rawQuery}`,
    );
    // A platform-API call would be recognisable by its path. Spelling
    // the forbidden shapes out keeps the invariant readable.
    for (const forbidden of ['/v1/organizations', '/databases', '/instances']) {
      assert.ok(
        !req.path.includes(forbidden),
        `request ${i} reached the Turso platform API: ${req.path}`,
      );
    }
  }
});

// The token travels in the Authorization header and nowhere else: not in the
// path, not in a query string, not in the request body.
test('the token travels only in the Authorization header', async (t) => {
  const { store, fake } = await openStore(t);
  await store.add(newTestTask(idA, 'a task'));

  for (const [i, req] of fake.seen().entries()) {
    assert.equal(
      req.auth,
      'Bearer ' + testToken,
      `request ${i} sent Authorization ${req.auth}, want the bearer token`,
    );
    assert.ok(
      !req.requestURI.includes(testToken),
      `request ${i} put the token in the URL: ${req.requestURI}`,
    );
    assert.ok(
      !req.body.includes(testToken),
      `request ${i} put the token in the body`,
    );
  }
});

// A store configured without a token sends no Authorization header at all,
// rather than an empty one: a self-hosted sqld may want no auth, and an
// empty bearer is a confusing thing to debug.
test('no token sends no Authorization header', async (t) => {
  const fake = await newFakeServer(t);
  const store = open({ ...fake.config(), token: new Secret('') });
  t.after(() => store.close());
  await store.init();
  assert.equal(
    fake.seen()[0]?.auth,
    '',
    'Authorization was sent, want it absent',
  );
});

// Every way the far end can disappoint us has to become an error a person can
// act on, and none of them may leak the credential.
test('HTTP failure modes', async (t) => {
  const cases: {
    name: string;
    handler: (res: ServerResponse) => void;
    wantCode: number;
    wantText: string;
  }[] = [
    {
      name: 'a rejected token points at tdo login',
      handler: (res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
      },
      wantCode: ExitConfig,
      wantText: 'tdo login',
    },
    {
      name: 'a forbidden token is also a credential problem',
      handler: (res) => {
        res.writeHead(403);
        res.end('forbidden');
      },
      wantCode: ExitConfig,
      wantText: 'tdo login',
    },
    {
      name: 'a missing endpoint names the path that was tried',
      handler: (res) => {
        res.writeHead(404);
        res.end('nope');
      },
      wantCode: ExitProvider,
      wantText: pipelinePath,
    },
    {
      name: 'a server error reports the status',
      handler: (res) => {
        res.writeHead(500);
        res.end('boom');
      },
      wantCode: ExitProvider,
      wantText: 'HTTP 500',
    },
    {
      name: 'an HTML error page from a proxy is summarised, not pasted',
      handler: (res) => {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end(
          '<html><head><title>502 Bad Gateway</title></head><body>' +
            'padding '.repeat(4000) +
            '</body></html>',
        );
      },
      wantCode: ExitProvider,
      wantText: 'HTTP 502',
    },
    {
      name: 'an HTML page with a 200 is not a pipeline reply',
      handler: (res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>hello</body></html>');
      },
      wantCode: ExitProvider,
      wantText: 'not a libSQL pipeline reply',
    },
    {
      name: 'a truncated body is reported as truncated',
      handler: (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"results":[{"type":"ok","respo');
      },
      wantCode: ExitProvider,
      wantText: 'ended before it was complete',
    },
    {
      name: 'an empty body is not a pipeline reply either',
      handler: (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end();
      },
      wantCode: ExitProvider,
      wantText: 'ended before it was complete',
    },
    {
      name: 'a pipeline-level error is reported',
      handler: (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"stream expired"}}');
      },
      wantCode: ExitProvider,
      wantText: 'refused the request',
    },
    {
      name: 'fewer results than statements is reported',
      handler: (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"results":[]}');
      },
      wantCode: ExitProvider,
      wantText: 'answered 0 statement(s)',
    },
    {
      name: 'an ok result with no result object is reported',
      handler: (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // One result per statement the listing sends, all of them
        // malformed in the same way.
        res.end('{"results":[{"type":"ok"},{"type":"ok"},{"type":"ok"}]}');
      },
      wantCode: ExitProvider,
      wantText: 'no result',
    },
    {
      name: 'a statement the engine refused becomes a provider error',
      handler: (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const one =
          '{"type":"error","error":{"message":"database is locked","code":"SQLITE_BUSY"}}';
        res.end(`{"results":[${one},${one},${one}]}`);
      },
      wantCode: ExitProvider,
      wantText: 'database is locked',
    },
  ];

  for (const tc of cases) {
    await t.test(tc.name, async (st) => {
      const url = await serveWith(st, tc.handler);
      const s = open(cfgFor(url));
      st.after(() => s.close());

      const err = await s.list(new Filter()).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(err !== undefined, 'list() succeeded, want an error');
      const message = (err as Error).message;
      assert.equal(
        classify(err).code,
        tc.wantCode,
        `exit code for ${tc.name} (error: ${message})`,
      );
      assert.ok(
        message.includes(tc.wantText),
        `error ${message} does not mention ${tc.wantText}`,
      );
      assert.ok(
        !message.includes(testToken),
        `the error leaks the credential: ${message}`,
      );
    });
  }
});

// A server that echoes the Authorization header back into its own error body
// must not get the token printed on the user's terminal by that route
// either: the snippet of a failed response is untrusted text like any other,
// and nothing downstream may treat a token in it as safe to show.
test('a server that echoes the token back does not get it into the error', async (t) => {
  const url = await serveWith(t, (res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    // The worst case: the far end repeats exactly what it was sent.
    res.end(`your request said Authorization: Bearer ${testToken}`);
  });
  const s = open(cfgFor(url));
  t.after(() => s.close());

  const err = await s.list(new Filter()).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err !== undefined, 'list() succeeded against a 500');
  const message = (err as Error).message;
  // The error reports the status, and the one thing it must not repeat is the
  // credential — whoever put it in the body.
  assert.ok(message.includes('HTTP 500'), message);
  assert.ok(
    !message.includes(testToken),
    `the error repeated the credential the server echoed: ${message}`,
  );
  // What the snippet carries instead is the redaction marker, so a reader of
  // the error can see that something was taken out rather than wonder.
  assert.ok(
    message.includes('[REDACTED]'),
    `the echoed credential was dropped silently rather than redacted: ${message}`,
  );
});

// A host that is not listening is a provider error, not a crash, and the
// message names the host rather than the whole request.
test('an unreachable host is a provider error', async (t) => {
  // Port 1 on loopback, because this test needs an address where nothing can
  // be listening. An earlier version took a real server's port and added one,
  // which was reliably wrong rather than unlucky: the OS hands out ephemeral
  // ports in near-sequence, so port+1 is about to be — or already is — the
  // port another test file's fake server got, and the request then succeeded
  // and came back as exit 3 instead of 4. Binding port 1 needs privileges no
  // test runner has.
  const dead = 'http://127.0.0.1:1';

  const s = open(cfgFor(dead));
  t.after(() => s.close());
  const err = await s.list(new Filter()).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err !== undefined, 'list() succeeded against a dead server');
  assert.equal(classify(err).code, ExitProvider, (err as Error).message);
  assert.ok(
    !(err as Error).message.includes(testToken),
    `the error leaks the credential: ${(err as Error).message}`,
  );
});

// A request that outlives this provider's own deadline is reported as the
// deadline, so a slow network does not look like a broken database. Go took
// the deadline from the caller's context; the Store interface carries none,
// so it is a Config option here and this is the test of it.
test('the configured timeout is honoured', async (t) => {
  let hang: (() => void) | undefined;
  const url = await serveWith(t, (res) => {
    hang = () => res.end();
  });
  t.after(() => hang?.());

  const s = open(cfgFor(url, 50));
  t.after(() => s.close());
  const err = await s.get(idA).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err !== undefined, 'get() succeeded against a server that never answers');
  const message = (err as Error).message;
  assert.ok(message.includes('timed out'), message);
  assert.equal(classify(err).code, ExitProvider, message);
  assert.ok(!message.includes(testToken), `the error leaks the credential: ${message}`);
});

// open is offline: a URL alone must not cause a request, so `tdo config` can
// build a store to describe it without touching the network.
test('open makes no request', async (t) => {
  const fake = await newFakeServer(t);
  const s = open(fake.config());
  t.after(() => s.close());
  assert.equal(fake.seen().length, 0, 'open made a request, want none');
});

// A URL that cannot be used is a configuration error, so the process exits 3
// with advice rather than 1.
test('open with a bad URL is a config error', () => {
  assert.throws(
    () => open({ url: 'ftp://example.turso.io', token: tokenForTest() }),
    (err: unknown) => {
      assert.equal(classify(err).code, ExitConfig);
      return true;
    },
  );
});
