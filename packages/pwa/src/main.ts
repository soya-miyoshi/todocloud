// The boot: the connect screen, the store behind it, and nothing else.
//
// This module is everything the PWA adds to the viewer the project already
// has. `public/app.js` and `public/app.css` are `packages/cli/assets`, byte
// for byte; `router.ts` and `api.ts` are the endpoints `tdo serve` serves,
// with the socket removed. What is genuinely new is only this: asking for a
// database and a token, saying plainly what holding that token in a browser
// means, opening the store, and pointing the page's `fetch` at it.
//
// Load order matters and `index.html` sets it. This module is a module, so it
// is deferred; `app.js` is marked `defer` and comes after it, so the shim is
// installed before the first line of the viewer runs and the viewer's opening
// request never escapes to a static host that has no `/api`.
//
// Nothing here registers the service worker. `app.js` does it already, at the
// end of the file, only in a secure context — exactly the condition a browser
// imposes — and a second registration of the same URL would be noise. What
// the worker caches is in `public/sw.js`, and the short version is: the five
// shell files, nothing else, ever.
//
// Offline, this app shows its shell and fails. There is no write queue and no
// local copy of the tree, which is a decision and not an omission: a queue is
// a second opinion about the list, and §10 of `PLAN.md` has not taken on
// multi-device conflict handling beyond last-write-wins. A page that accepted
// an edit it cannot deliver would be exactly the screen that looks live and
// is not — so a write with no network fails, with the provider's own message,
// and the user sees that it failed.

import { Secret } from '@todocloud/core/secret';
import * as turso from '@todocloud/store-turso';
import type { Store } from '@todocloud/core/store';

import {
  type Credential,
  type Storages,
  browserStorages,
  forget,
  load,
  mixedContent,
  remembered,
  rememberedURL,
  save,
  validateURL,
} from './credentials.ts';
import {
  type Doc,
  type Elem,
  document,
  pageScheme,
  reloader,
  workers,
} from './dom.ts';
import { Router, httpError } from './router.ts';
import { reloadOnUpdate } from './update.ts';
import { type Shim, install } from './shim.ts';
import type { Settings } from '@todocloud/core/webapi/http';

/**
 * The shim is installed first, before anything can await, so that `app.js`
 * — the next script in the document — finds a `fetch` that answers `/api`.
 */
const shim: Shim = install(globalThis);

/**
 * nativeFetch is the runtime's own fetch, captured by the shim before it
 * replaced the global. The provider is handed this one explicitly, so a
 * request carrying the `Authorization` header never passes through code of
 * ours: `@todocloud/store-turso` would otherwise bind whatever global is
 * installed at the time it opens a store, and that would be the shim.
 */
const nativeFetch = shim.original;

const storages: Storages = browserStorages(globalThis);

/** connected is the store this page is talking to, if any. */
let connected: { st: Store; router: Router } | undefined;

/**
 * page is the document, or undefined when there is none. Every element
 * access goes through `byID`, so a missing page makes this module inert
 * rather than throwing from its top level.
 */
const page: Doc | undefined = document();

const byID = (id: string): Elem | null => page?.getElementById(id) ?? null;

/** messageOf reads the text of a thrown value, whatever it is. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * refresh makes the viewer reload from the store. It clicks the viewer's own
 * reload button, which is the seam `app.js` already has: this module holds no
 * reference into the viewer's state, and the viewer needs no knowledge of
 * this one.
 */
function refresh(): void {
  byID('reload')?.click();
}

/**
 * openStore connects to a database. `openExisting` is used rather than `open`
 * for the same reason every command but `tdo init` uses it: it creates
 * nothing, and a database with no schema is reported as such instead of
 * quietly becoming a second, empty task list. This app cannot run `tdo init`
 * — writing a schema from a browser is a bigger decision than a connect form
 * should make — so it says to run it.
 */
async function openStore(cred: Credential): Promise<Store> {
  return turso.openExisting({
    url: cred.url,
    token: cred.token,
    // The captured original, never the global: see nativeFetch above.
    fetch: nativeFetch,
  });
}

/**
 * connect opens the store and hands it to the page. It returns the failure
 * message rather than showing it, because who shows it depends on who asked:
 * the server dialog keeps itself open and prints it, and a stored credential
 * that no longer works at launch is left to the status bar's "could not
 * connect" with the dialog one tap away.
 */
async function connect(cred: Credential): Promise<string | undefined> {
  let st: Store;
  try {
    st = await openStore(cred);
  } catch (err) {
    return messageOf(err);
  }
  await disconnectStore();
  const router = new Router(st);
  connected = { st, router };
  shim.connect(router);

  const where = byID('store');
  if (where !== null) {
    where.textContent = st.describe();
  }
  const which = byID('token-hint');
  if (which !== null) {
    // The fingerprint, never any part of the value: `[REDACTED]#1a2b3c4d`,
    // which is what `tdo login --show` prints and is safe to read out loud.
    which.textContent = cred.token.hint();
  }
  return undefined;
}

/** disconnectStore closes the open store, if there is one. */
async function disconnectStore(): Promise<void> {
  const open = connected;
  connected = undefined;
  shim.disconnect();
  if (open === undefined) {
    return;
  }
  try {
    await open.st.close();
  } catch {
    // Closing a store that talks over HTTP releases nothing a browser can
    // run out of, and a failure here must not stop the user disconnecting.
  }
}

/**
 * settings answers the server dialog. The URL is validated with the
 * provider's own parser before the token is touched, so a URL carrying a
 * query string or embedded credentials is refused here rather than sent
 * anywhere. An empty token keeps the stored one for the same database, which
 * is what lets the dialog be reopened without retyping a secret it never
 * received; a database with no token at all is a local sqld, and is allowed.
 */
async function settings(method: string, body: string | undefined): Promise<Response> {
  if (method === 'GET') {
    const view: Settings = {
      editable: true,
      url: rememberedURL(storages) ?? '',
      token_set: load(storages) !== undefined,
      remember: remembered(storages),
      notice: '',
    };
    return json(200, view);
  }
  if (method !== 'PUT') {
    return httpError(405, 'usage', `${method} is not allowed here`);
  }
  let asked: { url?: unknown; token?: unknown; remember?: unknown };
  try {
    asked = JSON.parse(body ?? '') as typeof asked;
  } catch {
    return httpError(400, 'usage', 'the settings request is not JSON');
  }
  const url = typeof asked.url === 'string' ? asked.url.trim() : '';
  let endpoint: string;
  try {
    ({ endpoint } = validateURL(url));
  } catch (err) {
    return httpError(400, 'usage', messageOf(err));
  }
  if (mixedContent(pageScheme(), endpoint)) {
    return httpError(
      400,
      'usage',
      'this page is served over https, and a browser will not let it reach an http:// database; serve the database over https, or open this app over http. A localhost address is the exception',
    );
  }
  const typed = typeof asked.token === 'string' ? asked.token.trim() : '';
  const stored = load(storages);
  const token = typed !== '' ? new Secret(typed) : stored !== undefined && stored.url === url ? stored.token : new Secret('');
  const cred = { url, token };
  const failure = await connect(cred);
  if (failure !== undefined) {
    return httpError(503, 'config', failure);
  }
  if (!save(storages, cred, asked.remember === true)) {
    return httpError(503, 'config', 'connected, but this browser would not store the token, so it is kept in memory for this tab only');
  }
  return json(200, { ok: true });
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * disconnect forgets the token and leaves the app on its "could not connect"
 * bar. It says what it did *not* do: removing this browser's copy is not
 * revoking the token, and the only place that happens is Turso.
 */
async function disconnect(): Promise<void> {
  forget(storages);
  await disconnectStore();
  refresh();
}

/** start wires the page and connects if a credential is already stored. */
async function start(): Promise<void> {
  shim.onSettings(settings);
  byID('disconnect')?.addEventListener('click', () => {
    void disconnect();
  });

  // The app opens first, always. Putting a form up for the moment it takes to
  // read storage and reach the database made every launch flash a token
  // prompt at someone who had already configured one. With nothing stored,
  // the viewer's own first request is answered by the shim with "could not
  // connect to sqlite server", which lands in its status bar; the Server
  // button is how to fix that.
  const cred = load(storages);
  if (cred !== undefined) {
    await connect(cred);
  }
  refresh();
}

// A page is the only reason to run any of this. Nothing imports this module
// — it is the entry point and the one place that replaces a global — but a
// module that threw when loaded without a document would be a module nobody
// could ever load to find out why.
if (page !== undefined) {
  reloadOnUpdate(workers(), reloader());
  void start();
}
