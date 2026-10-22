// The service worker. It caches the shell, and nothing else, ever.
//
// This is the one place the PWA deliberately parts company with
// `packages/cli/assets/sw.js`, which caches nothing at all. That worker is
// right for what it serves: the local viewer's page carries the write token
// of the process that served it, so a cached page would hold a token a
// restarted `tdo serve` no longer honours, and the first edit would fail
// with a 403 on the one device with no devtools window to find out why.
//
// This app has no server and no per-process token. It is a static site, and
// the whole reason it exists is to be installed on a phone, where a cold
// start with no shell is a blank screen. So the shell is cached.
//
// The policy, in full:
//
//   - **The precache list below is the only thing that may enter a cache.**
//     It is an allow-list of literal paths — the page, the two stylesheets,
//     the two scripts, the modules they import, the manifest and the icons.
//     Nothing is added at runtime from a response, and there is no code path
//     here that could add one.
//   - **No API response is ever cached, because it cannot reach this file.**
//     The PWA's API is not a URL: `shim.ts` answers `/api/*` inside the page
//     and a request that never leaves the tab never passes a service worker.
//     Every real request this app makes goes to the user's database on
//     another origin, and this worker does not call `respondWith` for a
//     cross-origin URL — so task data has no route into storage, and the
//     `Authorization` header on those requests is never seen by this file at
//     all.
//   - **A token can therefore never be cached**, which is the property that
//     matters on a shared or borrowed device: the one copy of the credential
//     is the one in `sessionStorage` or `localStorage`, which `credentials.ts`
//     owns and the connect screen explains, and clearing site data removes
//     it. There is no second copy in here for someone to find later.
//   - **The shell is served cache-first and revalidated behind the screen.**
//     Cache-first is what makes the installed app open instantly and work
//     with no network. The background revalidation is what keeps the copy
//     from going stale: after each shell response is served from the cache, a
//     fresh one is fetched and written over it, so the next launch runs the
//     current build. Both that fetch and the precache go past the browser's
//     HTTP cache (`cache: 'no-cache'` and `cache: 'reload'`), without which
//     "fresh" means "up to ten minutes old" on this host and a new worker
//     can precache the build it was installed to replace. A stale shell is a real hazard — the import map in the
//     page and the emitted modules have to agree — which is why the name
//     below carries the commit and `activate` deletes every cache that is
//     not this one.
//
// A worker is registered only in a secure context, which is what a browser
// requires. `app.js` does that registration, with `updateViaCache: 'none'`,
// so the worker itself is never served from the HTTP cache.
'use strict';

/**
 * CACHE is the cache name, and it is the whole invalidation strategy: a new
 * name is a new cache, `install` fills it from the allow-list below and
 * `activate` deletes every other one, so a deploy cannot leave a browser
 * holding half of one build and half of another.
 *
 * It therefore has to change with every deploy, and nothing a person has to
 * remember can be trusted to do that. `scripts/stamp-cache.mjs` replaces
 * this line with the commit on the way out (see `.github/workflows/pwa.yml`),
 * so the deployed name is `tdo-shell-<sha>` — the identity of the build, and
 * the only thing the name has to be. There is no version to bump by hand and
 * no second concept beside the commit.
 *
 * The literal here is what a local build runs under, which is why it is a
 * word rather than a number: served from `packages/pwa/dist` by hand, every
 * build is the same cache, and that is the right answer for a directory you
 * are rebuilding on purpose.
 */
const CACHE = 'tdo-shell-local';

/**
 * SHELL is the allow-list. These are the only URLs this worker will ever put
 * in a cache or answer from one, and they are matched exactly — a query
 * string makes a different URL, which is not on the list.
 *
 * The module paths are the layout `tsconfig.build.json` emits. A module
 * added to the app has to be added here too, or it is fetched from the
 * network on every launch and the app does not start offline. There is no
 * generator for this list on purpose: no bundler, no build-time manifest,
 * and a list short enough to read.
 */
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/connect.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',

  '/pwa/src/main.js',
  '/pwa/src/credentials.js',
  '/pwa/src/dom.js',
  '/pwa/src/router.js',
  '/pwa/src/shim.js',
  '/pwa/src/update.js',

  '/store-turso/src/turso.js',
  '/store-turso/src/client.js',
  '/store-turso/src/protocol.js',
  '/store-turso/src/query.js',
  '/store-turso/src/schema.js',

  '/core/src/exit.js',
  '/core/src/id.js',
  '/core/src/providercli.js',
  '/core/src/recur.js',
  '/core/src/secret.js',
  '/core/src/task.js',
  '/core/src/output/view.js',
  '/core/src/store/store.js',
  '/core/src/store/availability.js',
  '/core/src/store/completion.js',
  '/core/src/store/filter.js',
  '/core/src/store/schema.js',
  '/core/src/store/version.js',
  '/core/src/taskops/taskops.js',
  '/core/src/taskops/edit.js',
  '/core/src/taskops/select.js',

  // The shared API layer. There was a copy of this under `/pwa/src/api.js`;
  // it is one module in `core` now, imported by `router.ts` here and by
  // `packages/cli/src/web/web.ts` there.
  '/core/src/webapi/api.js',
  '/core/src/webapi/http.js',
];

/** shellURLs is the allow-list resolved against this origin, once. */
const shellURLs = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(fill().then(() => self.skipWaiting()));
});

/**
 * fill precaches the shell, from the network rather than from whatever the
 * browser happens to be holding.
 *
 * This was `cache.addAll(SHELL)`, and that is the line that made a deploy
 * not arrive. `addAll` fetches with the default cache mode, which consults
 * the HTTP cache — and GitHub Pages serves every file here with
 * `max-age=600`. So the new worker, whose entire reason for existing is that
 * the build changed, filled its brand-new cache with the ten-minute-old
 * copies of the previous build: a new cache name, the old bytes in it, the
 * old cache deleted, and nothing left to notice the difference until those
 * ten minutes lapsed and a background revalidation happened to run. The
 * shell is also the one place a mix of two builds is fatal — the import map
 * in the page and the emitted modules have to agree — so a precache that can
 * silently be a build behind is not a cache at all.
 *
 * `cache: 'reload'` is the fix: fetch from the network, ignore the HTTP
 * cache for the request, and write what came back into it.
 *
 * A shell that is only half cached is worse than none: the page would load
 * and its modules would not. So every response is collected before anything
 * is written, and one that did not arrive — or arrived as a 404 from a
 * misconfigured host — throws before the first `put`. A failed install
 * leaves the previous cache in place and the app online-only until the next
 * one succeeds, which is what `addAll`'s all-or-nothing gave us and is worth
 * keeping.
 */
async function fill() {
  const fresh = await Promise.all(
    SHELL.map(async (path) => {
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (!response.ok) {
        throw new Error(`sw: ${path} answered ${response.status}`);
      }
      return [path, response];
    }),
  );
  const cache = await caches.open(CACHE);
  await Promise.all(fresh.map(([path, response]) => cache.put(path, response)));
}

self.addEventListener('activate', (event) => {
  // Every other cache goes, including one from an older version of this
  // file: a mix of two builds is the failure this version number exists to
  // prevent.
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // A navigation to the app, however it is spelled, is the page. Anything
  // else that is not on the allow-list is left entirely alone — no
  // respondWith, so the browser makes the request itself and this file is
  // not in the path of a single byte of it. That is what keeps every request
  // to the user's database, and every header on one, out of here.
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  const key = request.mode === 'navigate' ? new URL('/', self.registration.scope).href : url.href;
  if (!shellURLs.has(key)) {
    return;
  }
  event.respondWith(shell(key, request));
});

/**
 * shell answers from the cache and refreshes the entry behind the answer.
 * The refresh is deliberately not awaited by the response: the point of the
 * cache is that the app opens now.
 */
async function shell(key, request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) {
    // The copy on disk is replaced only by a response that actually arrived
    // and was actually ok; a 404 from a misconfigured host must not evict a
    // working shell.
    // `no-cache`, not the default: the point of this request is to find out
    // what the server has now, and the default mode can answer it from the
    // HTTP cache — which on GitHub Pages means a copy up to ten minutes old,
    // for a check whose whole job is to be current. It still revalidates
    // rather than re-downloading, so an unchanged file costs a 304.
    // The key is used rather than `request`, because every entry on the
    // allow-list is a plain same-origin GET of a static file: a navigation
    // is answered by `/`, and that is the URL to refresh.
    const refresh = fetch(key, { cache: 'no-cache' })
      .then((fresh) => (fresh.ok ? cache.put(key, fresh) : undefined))
      .catch(() => undefined);
    // waitUntil is unavailable here, so the refresh is simply not awaited.
    // A worker killed before it finishes leaves the old entry, which is the
    // state we were already in.
    void refresh;
    return hit;
  }
  // Not cached — a shell file added without being added to SHELL, or an
  // install that failed. Go to the network and say so truthfully if it is
  // not there.
  return fetch(request);
}
