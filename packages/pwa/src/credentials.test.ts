// The credential handling, which is the half of this package that has
// nothing to do with a browser being present: storage is an interface
// (`KeyStore`), so every rule about where a token goes is testable under
// `node --test`.
//
// What these tests are for is the promise the connect screen makes. It says
// that an unchecked box keeps the token for the tab only; if `save` writes it
// to `localStorage` anyway, the page is lying to someone about a credential
// on a borrowed laptop. So the assertions are mostly about which storage a
// value is *not* in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Secret } from '@todocloud/core/secret';

import {
  type KeyStore,
  type Storages,
  forget,
  load,
  mixedContent,
  remembered,
  rememberedURL,
  save,
  tokenKey,
  urlKey,
  validateURL,
} from './credentials.ts';

/** exampleURL and testToken are the repository's placeholders (CLAUDE.md §1.3). */
const exampleURL = 'libsql://example.turso.io';
const testToken = 'TOKEN_GOES_HERE';

/** memory is a KeyStore in a Map, which is what a browser's Storage is. */
function memory(): KeyStore & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** blocked is the storage a browser hands back when site data is refused. */
function blocked(): KeyStore {
  const refuse = (): never => {
    throw new Error('the user denied storage for this site');
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

function storages(): Storages & { local: ReturnType<typeof memory>; session: ReturnType<typeof memory> } {
  return { local: memory(), session: memory() };
}

test('an unremembered token is in the session and never on the device', () => {
  const s = storages();
  assert.equal(save(s, { url: exampleURL, token: new Secret(testToken) }, false), true);

  assert.equal(s.session.map.get(tokenKey), testToken);
  assert.equal(s.local.map.has(tokenKey), false);
  // The URL is not a credential, so it is remembered either way.
  assert.equal(s.local.map.get(urlKey), exampleURL);
  assert.equal(remembered(s), false);
});

test('a remembered token is on the device and usable this session', () => {
  const s = storages();
  assert.equal(save(s, { url: exampleURL, token: new Secret(testToken) }, true), true);

  assert.equal(s.local.map.get(tokenKey), testToken);
  // Also in the session copy, so that a "remember" and a plain connect leave
  // the tab in the same working state.
  assert.equal(s.session.map.get(tokenKey), testToken);
  assert.equal(remembered(s), true);
});

test('unchecking the box removes the copy that would have outlived the tab', () => {
  const s = storages();
  save(s, { url: exampleURL, token: new Secret(testToken) }, true);
  save(s, { url: exampleURL, token: new Secret(testToken) }, false);

  assert.equal(s.local.map.has(tokenKey), false);
  assert.equal(s.session.map.get(tokenKey), testToken);
  assert.equal(remembered(s), false);
});

test('load wraps the token in a Secret and nothing prints it', () => {
  const s = storages();
  save(s, { url: exampleURL, token: new Secret(testToken) }, false);

  const cred = load(s);
  assert.notEqual(cred, undefined);
  assert.equal(cred?.url, exampleURL);
  assert.equal(cred?.token.reveal(), testToken);
  // The two ways a credential usually escapes.
  assert.equal(String(cred?.token), '[REDACTED]');
  assert.equal(JSON.stringify({ token: cred?.token }), '{"token":"[REDACTED]"}');
});

test('the session token wins over the device one', () => {
  const s = storages();
  s.local.map.set(urlKey, exampleURL);
  s.local.map.set(tokenKey, 'TOKEN_GOES_HERE_OLD');
  s.session.map.set(tokenKey, testToken);

  assert.equal(load(s)?.token.reveal(), testToken);
});

test('a missing token is no credential at all, even with a URL', () => {
  const s = storages();
  s.local.map.set(urlKey, exampleURL);

  assert.equal(load(s), undefined);
  // The connect form still gets its URL back.
  assert.equal(rememberedURL(s), exampleURL);
});

test('forget removes every copy of the token and keeps the URL', () => {
  const s = storages();
  save(s, { url: exampleURL, token: new Secret(testToken) }, true);
  forget(s);

  assert.equal(load(s), undefined);
  assert.equal(s.local.map.has(tokenKey), false);
  assert.equal(s.session.map.has(tokenKey), false);
  assert.equal(rememberedURL(s), exampleURL);
});

test('a blocked storage is reported rather than swallowed', () => {
  // Both storages refuse: the app has to say that nothing was stored instead
  // of telling the user their token was remembered.
  const s: Storages = { local: blocked(), session: blocked() };
  assert.equal(save(s, { url: exampleURL, token: new Secret(testToken) }, true), false);
  assert.equal(load(s), undefined);
  assert.equal(rememberedURL(s), undefined);
  assert.equal(remembered(s), false);
  // And forgetting a credential that could not be stored is not an error.
  forget(s);
});

test('an absent storage is an absent storage, not a crash', () => {
  const s: Storages = { local: undefined, session: undefined };
  assert.equal(save(s, { url: exampleURL, token: new Secret(testToken) }, false), false);
  assert.equal(load(s), undefined);
});

test('validateURL is the provider\'s own parser, so a token cannot hide in a URL', () => {
  assert.deepEqual(validateURL(exampleURL), {
    endpoint: 'https://example.turso.io/v2/pipeline',
    host: 'example.turso.io',
  });

  // The three refusals that matter for a credential: a query string, a
  // fragment, and userinfo. Each message says why.
  assert.throws(() => validateURL(`${exampleURL}?authToken=TOKEN_GOES_HERE`), /query string/);
  assert.throws(() => validateURL(`${exampleURL}#TOKEN_GOES_HERE`), /fragment/);
  assert.throws(() => validateURL('libsql://TOKEN_GOES_HERE@example.turso.io'), /credentials/);
  // And the ordinary mistakes.
  assert.throws(() => validateURL(''), /no database URL/);
  assert.throws(() => validateURL('example.turso.io'), /no scheme/);
  assert.throws(() => validateURL('ftp://example.turso.io'), /scheme/);
});

test('mixed content is caught before the request, not after', () => {
  assert.equal(mixedContent('https:', 'http://sqld.example.com:8080/v2/pipeline'), true);
  assert.equal(mixedContent('http:', 'http://sqld.example.com:8080/v2/pipeline'), false);
  // Loopback is let through: browsers treat it as a secure context.
  assert.equal(mixedContent('https:', 'http://localhost:8080/v2/pipeline'), false);
  assert.equal(mixedContent('https:', 'http://127.0.0.1:8080/v2/pipeline'), false);
  assert.equal(mixedContent('https:', 'http://[::1]:8080/v2/pipeline'), false);
  assert.equal(mixedContent('https:', 'http://localhost.evil.example/v2/pipeline'), true);
  assert.equal(mixedContent('https:', 'https://example.turso.io/v2/pipeline'), false);
});
