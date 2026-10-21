// The shim, which is the one piece of this package that replaces a global.
//
// Three things have to hold, and each of them is a way the credential could
// otherwise leak or the app could otherwise break:
//
//   1. A request that is not `/api/…` goes to the captured original,
//      untouched. The provider's requests — the ones carrying the token —
//      are handed the original directly and never arrive here at all, but a
//      shim that mangled a pass-through would still be a shim that could.
//   2. `/api/…` never reaches the network. If it did, a static host would
//      answer 404 and, worse, the request would have left the device.
//   3. Disconnected, `/api/…` answers with the `config` envelope rather than
//      with a network error, so the page says what to do.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Shim, apiPrefix } from './shim.ts';
import { Router } from './router.ts';

/**
 * recorder is a stand-in for the runtime's fetch: it records what it was
 * given and answers, so a pass-through is visible.
 */
function recorder(): {
  readonly calls: { url: string; method: string | undefined }[];
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
} {
  const calls: { url: string; method: string | undefined }[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response('{"from":"the network"}', { status: 200 });
    },
  };
}

/**
 * stub is a Router that records instead of touching a store. The real one is
 * exercised against a real store in `router.test.ts`; what matters here is
 * only what the shim hands it.
 */
function stub(): {
  readonly seen: { method: string; path: string; body: string | undefined }[];
  router: Router;
} {
  const seen: { method: string; path: string; body: string | undefined }[] = [];
  const router = Object.create(Router.prototype) as Router;
  (router as { handle: Router['handle'] }).handle = async (method, path, body) => {
    seen.push({ method, path, body });
    return new Response('{"from":"the page"}', { status: 200 });
  };
  return { seen, router };
}

test('a request that is not the API goes to the original fetch', async () => {
  const net = recorder();
  const shim = new Shim(net.fetch);
  const { router } = stub();
  shim.connect(router);

  const res = await shim.fetch('https://example.turso.io/v2/pipeline', { method: 'POST' });
  assert.equal(await res.text(), '{"from":"the network"}');
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0]?.url, 'https://example.turso.io/v2/pipeline');
  assert.equal(net.calls[0]?.method, 'POST');
});

test('an API request is answered in the page and never reaches the network', async () => {
  const net = recorder();
  const shim = new Shim(net.fetch);
  const { seen, router } = stub();
  shim.connect(router);

  const res = await shim.fetch('/api/state');
  assert.equal(await res.text(), '{"from":"the page"}');
  assert.equal(net.calls.length, 0);
  assert.deepEqual(seen, [{ method: 'GET', path: '/api/state', body: undefined }]);
});

test('the method and the body arrive as the handler expects them', async () => {
  const net = recorder();
  const shim = new Shim(net.fetch);
  const { seen, router } = stub();
  shim.connect(router);

  await shim.fetch('/api/tasks', { method: 'post', body: '{"title":"x"}' });
  await shim.fetch('/api/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV', { method: 'DELETE' });

  assert.deepEqual(seen, [
    // Lower-cased in the call, upper-cased for the route table.
    { method: 'POST', path: '/api/tasks', body: '{"title":"x"}' },
    // No body at all, which is how `fetch` sends a DELETE and what
    // `optionalBody` reads as every default.
    { method: 'DELETE', path: '/api/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV', body: undefined },
  ]);
});

test('a query string on an API path does not escape the router', async () => {
  const net = recorder();
  const shim = new Shim(net.fetch);
  const { seen, router } = stub();
  shim.connect(router);

  await shim.fetch('/api/state?cachebust=1');
  assert.equal(net.calls.length, 0);
  // The path the route table matches is the pathname, as on a server.
  assert.equal(seen[0]?.path, '/api/state');
});

test('disconnected, the API answers with the config envelope', async () => {
  const net = recorder();
  const shim = new Shim(net.fetch);
  assert.equal(shim.connected(), false);

  const res = await shim.fetch('/api/state');
  assert.equal(res.status, 503);
  const payload = (await res.json()) as { error?: { code?: string; message?: string } };
  assert.equal(payload.error?.code, 'config');
  // The message tells the user what to do, because the page shows it.
  assert.match(payload.error?.message ?? '', /Turso URL and token/);
  assert.equal(net.calls.length, 0);
});

test('connect and disconnect do not replace the global twice', async () => {
  const net = recorder();
  const shim = new Shim(net.fetch);
  const { router } = stub();

  shim.connect(router);
  assert.equal(shim.connected(), true);
  shim.disconnect();
  assert.equal(shim.connected(), false);
  // The same bound function throughout: `globalThis.fetch` is assigned once,
  // at boot, and a reconnect does not stack another wrapper on it.
  assert.equal((await shim.fetch('/api/state')).status, 503);
});

test('the shim answers exactly one path space', () => {
  // Stated as a test because it is a contract with `app.js`, which builds
  // every request path from this literal.
  assert.equal(apiPrefix, '/api/');
});
