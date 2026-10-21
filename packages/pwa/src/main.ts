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
import { Filter } from '@todocloud/core/store/filter';
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
  type Ev,
  document,
  pageScheme,
  reloader,
  workers,
} from './dom.ts';
import { arrived, badge, showBadge } from './badge.ts';
import { Router } from './router.ts';
import { reloadOnUpdate } from './update.ts';
import { type Shim, install } from './shim.ts';

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

/**
 * note writes to the connect screen's own status line. The viewer has its
 * own (`.status`, driven by `app.js`); this one is for the half of the app
 * that happens before there is a store to report about.
 */
function note(message: string, isError = false): void {
  const node = byID('connect-status');
  if (node === null) {
    return;
  }
  node.textContent = message;
  node.classList.toggle('error', isError);
}

/** messageOf reads the text of a thrown value, whatever it is. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * showConnect switches between the two screens. The viewer's markup stays in
 * the document either way — `app.js` queries it at load and expects it to be
 * there — so this hides it rather than building it.
 */
function showConnect(show: boolean): void {
  byID('connect')?.toggleAttribute('hidden', !show);
  byID('app')?.toggleAttribute('hidden', show);
  page?.body.classList.toggle('connecting', show);
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
 * connect opens the store and hands it to the page. It reports its own
 * failures to the connect screen and leaves the form on screen, because
 * every way this fails is something the user can correct there: a wrong URL,
 * a token for another database, an expired token, a database with no schema.
 */
async function connect(cred: Credential, stored: boolean): Promise<void> {
  note('connecting…');
  let st: Store;
  try {
    st = await openStore(cred);
  } catch (err) {
    note(messageOf(err), true);
    return;
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
  showConnect(false);
  note('');
  refresh();
  void updateBadge();
  if (!stored) {
    // Said after the store opened, so a token that does not work is never
    // reported as remembered.
    const remember = byID('remember')?.checked === true;
    if (!save(storages, cred, remember)) {
      note('this browser would not store the token, so it is kept in memory for this tab only', true);
    }
  }
}

/**
 * updateBadge counts the tasks whose due or defer day has arrived and puts
 * the number on the app icon. It reads the store directly rather than the
 * viewer's list, so the count does not depend on which pane is open. A failed
 * read leaves the badge as it was: a number from a minute ago is better than
 * a cleared badge that says nothing is due.
 */
async function updateBadge(): Promise<void> {
  const open = connected;
  const api = badge();
  if (open === undefined || api === undefined) {
    return;
  }
  try {
    await showBadge(api, arrived(await open.st.list(new Filter()), new Date()));
  } catch {
    // See above.
  }
}

/**
 * askForBadge requests notification permission on the first tap, which is
 * what iOS needs before it draws a badge, and which it only grants from a
 * user gesture. Nothing is ever sent as a notification; the permission is
 * only the key to the badge.
 */
function askForBadge(): void {
  const n = (globalThis as unknown as { Notification?: { permission: string; requestPermission(): Promise<string> } })
    .Notification;
  if (n === undefined || n.permission !== 'default' || badge() === undefined) {
    return;
  }
  page?.body.addEventListener('click', () => {
    if (n.permission === 'default') {
      void n.requestPermission().then(() => updateBadge());
    }
  });
}

/** disconnectStore closes the open store, if there is one. */
async function disconnectStore(): Promise<void> {
  const open = connected;
  connected = undefined;
  shim.disconnect();
  void badge()?.clearAppBadge().catch(() => undefined);
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
 * submit reads the form. The URL is validated with the provider's own parser
 * before the token is touched, so a URL carrying a query string or embedded
 * credentials is refused here rather than being sent anywhere.
 */
async function submit(event: Ev): Promise<void> {
  event.preventDefault();
  const urlField = byID('turso-url');
  const tokenField = byID('turso-token');
  if (urlField === null || tokenField === null) {
    return;
  }
  const url = (urlField.value ?? '').trim();
  let endpoint: string;
  try {
    ({ endpoint } = validateURL(url));
  } catch (err) {
    note(messageOf(err), true);
    urlField.focus();
    return;
  }
  if (mixedContent(pageScheme(), endpoint)) {
    note(
      'this page is served over https, and a browser will not let it reach an http:// database; serve the database over https, or open this app over http',
      true,
    );
    urlField.focus();
    return;
  }
  const token = (tokenField.value ?? '').trim();
  if (token === '') {
    note('paste the database token for that database', true);
    tokenField.focus();
    return;
  }
  // The field is cleared as soon as the value is wrapped: a token sitting in
  // an input is a token in the DOM, which the next screenshot or the next
  // autofill prompt can carry further than anyone intended.
  tokenField.value = '';
  await connect({ url, token: new Secret(token) }, false);
}

/**
 * disconnect forgets the token and puts the connect screen back. It says
 * what it did *not* do: removing this browser's copy is not revoking the
 * token, and the only place that happens is Turso.
 */
async function disconnect(): Promise<void> {
  forget(storages);
  await disconnectStore();
  showConnect(true);
  note('the token is gone from this browser. It is still valid at Turso until you revoke it there.');
}

/** start wires the page and connects if a credential is already stored. */
async function start(): Promise<void> {
  byID('connect-form')?.addEventListener('submit', (event) => {
    void submit(event);
  });
  byID('disconnect')?.addEventListener('click', () => {
    void disconnect();
  });

  const urlField = byID('turso-url');
  const known = rememberedURL(storages);
  if (urlField !== null && known !== undefined) {
    urlField.value = known;
  }
  const box = byID('remember');
  if (box !== null) {
    box.checked = remembered(storages);
  }

  const cred = load(storages);
  if (cred === undefined) {
    showConnect(true);
    return;
  }
  showConnect(true);
  await connect(cred, true);
}

// A page is the only reason to run any of this. Nothing imports this module
// — it is the entry point and the one place that replaces a global — but a
// module that threw when loaded without a document would be a module nobody
// could ever load to find out why.
if (page !== undefined) {
  reloadOnUpdate(workers(), reloader());
  askForBadge();
  // Coming back to the app is when the day may have turned, or a task been
  // changed from another device.
  (globalThis as unknown as { document: { addEventListener(t: string, l: () => void): void; visibilityState: string } })
    .document.addEventListener('visibilitychange', () => {
      if ((globalThis as unknown as { document: { visibilityState: string } }).document.visibilityState === 'visible') {
        void updateBadge();
      }
    });
  void start();
}
