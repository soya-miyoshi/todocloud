// Where the credential lives, and the honest account of what that costs.
//
// The PWA talks to the user's database directly, so it has to hold that
// database's token. There is no server to hold it instead — that was the
// whole point of §1 of `PLAN.md`, and a relay that held the token would be
// the backend this project dropped.
//
// So the token is in browser storage, and this is what that means:
//
//   - **Any script that runs on this origin can read it.** `Secret` keeps it
//     out of a log line and out of `JSON.stringify`; it is not a sandbox.
//     Anyone with devtools open, or any script that achieves XSS here, reads
//     the value with one call. The defence is that this origin serves five
//     hand-written files and no third-party script, not that the value is
//     hidden.
//   - **Storage is per origin, not per tab.** Another page on the same origin
//     shares it. That is the same statement as the one above.
//   - **It cannot be revoked from here.** Clearing storage removes this
//     browser's copy; it does not end the token's life. Revoking happens at
//     Turso.
//
// What follows from that is the shape of this module. The token is written
// to `sessionStorage` by default, which a closed tab takes with it, so the
// person on a borrowed or shared machine leaves nothing behind. Keeping it
// across restarts is a choice the user makes explicitly, and `index.html`
// says what they are choosing before they paste anything.
//
// The database URL is stored separately, and always in `localStorage`. A
// database URL is not a credential — `SECURITY.md` says so, and `tdo config`
// writes one into a file it refuses to put a token in — and remembering it
// means the person retypes only the part that matters.
//
// Nothing here ever puts the token in a URL, a query string or a fragment.
// `endpointFor` in `@todocloud/store-turso` refuses a URL carrying either,
// and `validateURL` below is that same function: the refusal is the
// provider's, not a second opinion written here.

import { Secret } from '@todocloud/core/secret';
import { endpointFor } from '@todocloud/store-turso';

/**
 * urlKey holds the database URL, which is not a credential, and tokenKey
 * holds the one that is. They are separate keys because they have different
 * lifetimes: the URL is remembered, the token is remembered only if asked.
 */
export const urlKey = 'todocloud.turso.url';
export const tokenKey = 'todocloud.turso.token';

/**
 * rememberKey records which storage the token was last written to, so that a
 * reload knows whether to offer "remembered on this device" or not. It holds
 * no part of the credential.
 */
export const rememberKey = 'todocloud.turso.remember';

/**
 * KeyStore is the slice of the DOM `Storage` interface this module uses. It
 * is an interface rather than `Storage` itself so that a test runs under
 * `node --test` with no DOM, and so that every access goes through the
 * try/catch in `read` and `write` — a `Storage` property getter throws
 * outright when site data is blocked, which is a configuration a browser
 * really does ship.
 */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Storages is where this module keeps things: `local` survives a restart,
 * `session` does not. Both are passed in rather than read off `globalThis`,
 * for the testability reason above and because either can be absent.
 */
export interface Storages {
  readonly local: KeyStore | undefined;
  readonly session: KeyStore | undefined;
}

/** Credential is a database and the token for it. */
export interface Credential {
  readonly url: string;
  readonly token: Secret;
}

/**
 * browserStorages reads the two storages off the global object, tolerating
 * the absence of either. Touching `localStorage` throws rather than returning
 * null when site data is blocked, which is why this is a try/catch and not a
 * property read.
 */
export function browserStorages(global: typeof globalThis): Storages {
  return { local: pick(global, 'localStorage'), session: pick(global, 'sessionStorage') };
}

function pick(global: typeof globalThis, name: 'localStorage' | 'sessionStorage'): KeyStore | undefined {
  try {
    const store = (global as unknown as Record<string, unknown>)[name];
    if (store === null || store === undefined) {
      return undefined;
    }
    const candidate = store as KeyStore;
    if (typeof candidate.getItem !== 'function') {
      return undefined;
    }
    return candidate;
  } catch {
    // Blocked site data, a sandboxed iframe, a private window with storage
    // turned off: the app has to work without it, which means asking for the
    // token again every time rather than failing to start.
    return undefined;
  }
}

/** read returns a stored string, or undefined for absent, empty or unreadable. */
function read(store: KeyStore | undefined, key: string): string | undefined {
  if (store === undefined) {
    return undefined;
  }
  try {
    const value = store.getItem(key);
    return value === null || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** write stores a string, reporting whether it landed. */
function write(store: KeyStore | undefined, key: string, value: string): boolean {
  if (store === undefined) {
    return false;
  }
  try {
    store.setItem(key, value);
    return true;
  } catch {
    // A full or disabled storage. The app keeps the credential in memory for
    // this session and says so, rather than claiming to have remembered it.
    return false;
  }
}

function drop(store: KeyStore | undefined, key: string): void {
  if (store === undefined) {
    return;
  }
  try {
    store.removeItem(key);
  } catch {
    // Nothing to do and nothing to report: the caller is already forgetting.
  }
}

/**
 * rememberedURL is the database URL for the connect form to start from. It is
 * read separately from the token because it is usually there when the token
 * is not: the token is gone with the tab, the URL is not a secret.
 */
export function rememberedURL(s: Storages): string | undefined {
  return read(s.local, urlKey);
}

/**
 * remembered reports whether the last saved token was asked to survive a
 * restart. The answer drives one checkbox and nothing else.
 */
export function remembered(s: Storages): boolean {
  return read(s.local, rememberKey) === 'local';
}

/**
 * load returns the stored credential, or undefined when there is no token to
 * be found. The session copy wins over the device copy, so that a tab which
 * was given a different token this session keeps using it.
 *
 * The token is wrapped the moment it leaves storage and is never held as a
 * plain string by this module's callers.
 */
export function load(s: Storages): Credential | undefined {
  const url = read(s.session, urlKey) ?? read(s.local, urlKey);
  const token = read(s.session, tokenKey) ?? read(s.local, tokenKey);
  if (url === undefined || token === undefined) {
    return undefined;
  }
  return { url, token: new Secret(token) };
}

/**
 * save stores a credential. `remember` chooses the storage for the token:
 * false — the default, and what the form offers unchecked — writes it to
 * `sessionStorage`, which the browser discards when the tab closes.
 *
 * It returns whether the token was actually stored, so the caller can tell
 * the user that it was not. Reporting "saved" for a write that a blocked
 * storage swallowed would send someone away believing a credential is
 * somewhere it is not.
 */
export function save(s: Storages, cred: Credential, remember: boolean): boolean {
  // The URL is remembered on the device either way; it is not a credential.
  write(s.local, urlKey, cred.url);
  write(s.local, rememberKey, remember ? 'local' : 'session');
  // The token is written to exactly one storage, and the other is cleared, so
  // that unchecking the box on a second visit really does remove the copy
  // that would have outlived the tab.
  const target = remember ? s.local : s.session;
  const other = remember ? s.session : s.local;
  drop(other, tokenKey);
  // The session copy is always present while a tab is connected, so a
  // "remember" that failed to write still leaves this session working.
  if (remember) {
    write(s.session, tokenKey, cred.token.reveal());
  } else {
    write(s.session, urlKey, cred.url);
  }
  return write(target, tokenKey, cred.token.reveal());
}

/**
 * forget removes every stored copy of the token from this browser. It leaves
 * the URL, because the next connect form should still be prefilled, and it
 * says plainly in the UI that forgetting is not revoking.
 */
export function forget(s: Storages): void {
  drop(s.local, tokenKey);
  drop(s.session, tokenKey);
  drop(s.local, rememberKey);
}

/**
 * validateURL refuses a database URL the provider would refuse, before a
 * token is pasted against it. The check is `endpointFor`, the provider's own
 * parser, so there is one answer to "is this a usable URL" and not two —
 * including its refusal of a URL carrying credentials, a query string or a
 * fragment, which is what keeps a token out of a URL here.
 *
 * It returns the wire origin the browser will actually be asked to reach,
 * which `mixedContent` below is the only consumer of.
 */
export function validateURL(raw: string): { endpoint: string; host: string } {
  return endpointFor(raw);
}

/**
 * mixedContent reports whether a page served over https would be blocked
 * reaching this endpoint. A browser refuses a plain-http request from an
 * https page outright, and the error it raises is a generic network failure,
 * so this is worth saying before the request rather than after: a
 * self-hosted sqld on `http://` is reachable from a page served on `http://`
 * or from localhost, and not otherwise.
 *
 * A loopback endpoint is the exception: Chrome and Firefox treat
 * `localhost`, `127.0.0.1` and `[::1]` as potentially trustworthy and let an
 * https page reach them, which is how a hosted copy of this app talks to a
 * sqld on the same machine. Safari does not, so there the request can still
 * fail — but refusing it here would stop the browsers that allow it.
 */
export function mixedContent(pageOrigin: string, endpoint: string): boolean {
  return pageOrigin.startsWith('https:') && endpoint.startsWith('http:') && !loopback(endpoint);
}

function loopback(endpoint: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(endpoint);
}
