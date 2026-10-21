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

import type { Reloader, Workers } from './dom.ts';

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
