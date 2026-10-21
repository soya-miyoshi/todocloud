// `reloadOnUpdate`: the page noticing that a new worker has taken charge.
//
// `./update.ts` rather than `./main.ts` deliberately. Importing `main.ts`
// installs the shim over the process's `fetch`, which `bun test` — one
// process for every file — would let escape into every other test in the
// repository. `update.ts` exists so this test has nothing to import but the
// function.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reloadOnUpdate } from './update.ts';
import type { Reloader, Workers } from './dom.ts';

/**
 * fakeWorkers is `navigator.serviceWorker` with a settable controller and a
 * `fire` that does what the browser does when a different worker claims the
 * page.
 */
function fakeWorkers(controller: unknown): Workers & { fire(): void; listeners: number } {
  const listeners: (() => void)[] = [];
  return {
    controller,
    addEventListener(type: string, listener: () => void): void {
      assert.equal(type, 'controllerchange');
      listeners.push(listener);
    },
    fire(): void {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    get listeners(): number {
      return listeners.length;
    },
  };
}

/** fakeReloader counts reloads instead of performing one. */
function fakeReloader(): Reloader & { count: number } {
  let count = 0;
  return {
    reload(): void {
      count += 1;
    },
    get count(): number {
      return count;
    },
  };
}

test('a worker taking over an already-controlled page reloads it', () => {
  const sw = fakeWorkers({});
  const loc = fakeReloader();
  reloadOnUpdate(sw, loc);
  assert.equal(loc.count, 0, 'nothing happens until a worker actually changes');
  sw.fire();
  assert.equal(loc.count, 1);
});

test('a second change in one page life does not reload again', () => {
  // The guard that matters: a reload begins a new page, so two reloads from
  // one module would be a page reloading itself in a loop.
  const sw = fakeWorkers({});
  const loc = fakeReloader();
  reloadOnUpdate(sw, loc);
  sw.fire();
  sw.fire();
  assert.equal(loc.count, 1);
});

test('the first-ever registration does not reload', () => {
  // `controller` is null until a worker controls the page, and the first
  // visit fires `controllerchange` for the worker it just registered.
  // Reloading there would reload every first launch for no reason.
  for (const controller of [null, undefined]) {
    const sw = fakeWorkers(controller);
    const loc = fakeReloader();
    reloadOnUpdate(sw, loc);
    assert.equal(sw.listeners, 0, 'no listener is even registered');
    assert.equal(loc.count, 0);
  }
});

test('no service worker and no location are both survivable', () => {
  // A browser without service worker support, and an environment with no
  // location at all. Neither is an error: there are simply no updates to
  // notice.
  const loc = fakeReloader();
  reloadOnUpdate(undefined, loc);
  assert.equal(loc.count, 0);

  const sw = fakeWorkers({});
  reloadOnUpdate(sw, undefined);
  assert.equal(sw.listeners, 0);
});
