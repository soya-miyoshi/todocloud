// Making an update arrive in the launch that fetches it.
//
// Its own module, and not a few lines at the end of `main.ts`, for one
// reason: importing `main.ts` installs the shim over the process's `fetch`,
// because that is the first thing it does and it has to be. `node --test`
// gives each file its own process and would not care, but `bun test` runs
// every file in one — and both runtimes have to stay green (CLAUDE.md §3).
// A test that reached this function through `main.ts` therefore replaced
// `fetch` for the whole Bun run and took every HTTP test in the repository
// with it. So the testable part lives here, where it imports nothing that
// touches a global.

import type { Doc, Reloader, Workers } from './dom.ts';

/**
 * reloadOnUpdate makes an update arrive in the launch that fetches it,
 * rather than the one after.
 *
 * The deploy gives `public/sw.js` a cache name carrying the commit
 * (`.github/workflows/pwa.yml`), so a new build is always a changed worker
 * file, and `app.js` registers with `updateViaCache: 'none'` so that file is
 * always read from the network. A new worker therefore installs, precaches
 * the new shell, and calls `skipWaiting` and `clients.claim()`.
 *
 * What claiming does not do is re-run the page that is already open — and
 * that page was answered cache-first from the *previous* shell, moments
 * earlier, before the new worker existed. Without this, the launch that
 * downloads an update still shows the old build and the next one shows the
 * new, which on a phone is indistinguishable from the update not having
 * worked.
 *
 * So the page reloads itself once when a different worker takes charge. Two
 * guards keep that from being a loop or a surprise:
 *
 *   - **Only when there was already a controller.** The very first visit
 *     registers a worker and `controllerchange` fires for it; reloading then
 *     would reload every first-ever launch for no reason.
 *   - **Only once.** `done` is module state, so a worker that changed twice
 *     in one page's life reloads it once. A reload begins a new page with a
 *     new module, which is then controlled by the worker it was served from,
 *     so the condition above is false and the second reload cannot happen.
 *
 * A reload is safe here in a way it would not be in the local viewer: this
 * page holds no server-issued token to lose, the credential is in storage
 * that survives it, and nothing is queued in the tab — a write either
 * reached the database or failed and said so.
 */
export function reloadOnUpdate(sw: Workers | undefined, loc: Reloader | undefined): void {
  if (sw === undefined || loc === undefined || sw.controller === null || sw.controller === undefined) {
    return;
  }
  let done = false;
  sw.addEventListener('controllerchange', () => {
    if (done) {
      return;
    }
    done = true;
    loc.reload();
  });
}

/**
 * checkOnResume asks the browser to look for a new worker whenever the app
 * comes back to the foreground.
 *
 * `app.js` registers the worker inside `window.addEventListener('load')`,
 * and registering is what makes the browser check `sw.js` for a changed
 * byte. On a desktop tab that is enough, because a visit is a load. An
 * installed app on a phone is the opposite: it is opened once and from then
 * on *resumed* — the page is still there, `load` has long since fired, and
 * nothing asks again. So a deploy could sit unnoticed for as long as the
 * person kept using the app, which is exactly the shape of "the PWA is not
 * updating".
 *
 * `update()` costs one conditional request for `sw.js` per time the app is
 * brought to the front, and nothing else: an unchanged file ends there, and
 * a changed one installs, precaches the new shell, claims the page and
 * `reloadOnUpdate` above reloads it.
 */
export function checkOnResume(sw: Workers | undefined, doc: Doc | undefined): void {
  const getRegistration = sw?.getRegistration;
  const addEventListener = doc?.addEventListener;
  if (sw === undefined || doc === undefined || getRegistration === undefined || addEventListener === undefined) {
    return;
  }
  addEventListener.call(doc, 'visibilitychange', () => {
    if (doc.visibilityState !== 'visible') {
      return;
    }
    // Nothing is awaited and nothing is reported: a failed check is a
    // network that is down, which this app says elsewhere and loudly.
    void getRegistration
      .call(sw)
      .then((registration) => registration?.update())
      .catch(() => undefined);
  });
}
