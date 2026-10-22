// `reloadOnUpdate`: the page noticing that a new worker has taken charge.
//
// `./update.ts` rather than `./main.ts` deliberately. Importing `main.ts`
// installs the shim over the process's `fetch`, which `bun test` — one
// process for every file — would let escape into every other test in the
// repository. `update.ts` exists so this test has nothing to import but the
// function.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkOnResume, reloadOnUpdate } from './update.ts';
import type { Doc, Elem, Reloader, Registration, Workers } from './dom.ts';

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

/**
 * fakeDoc is the document as `checkOnResume` sees it: a visibility state
 * that the test sets, and a `show` that fires the event the browser fires
 * when the app comes back to the front.
 */
function fakeDoc(): Doc & { show(state: string): void; listeners: number } {
  const listeners: (() => void)[] = [];
  let state = 'visible';
  return {
    getElementById(): Elem | null {
      return null;
    },
    get body(): Elem {
      throw new Error('fakeDoc has no body');
    },
    get visibilityState(): string {
      return state;
    },
    addEventListener(type: string, listener: () => void): void {
      assert.equal(type, 'visibilitychange');
      listeners.push(listener);
    },
    show(next: string): void {
      state = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    get listeners(): number {
      return listeners.length;
    },
  };
}

/** fakeRegistered counts update checks instead of making a request. */
function fakeRegistered(): Workers & { checks: number } {
  let checks = 0;
  const registration: Registration = {
    update(): Promise<unknown> {
      checks += 1;
      return Promise.resolve(undefined);
    },
  };
  return {
    controller: {},
    addEventListener(): void {},
    getRegistration(): Promise<Registration> {
      return Promise.resolve(registration);
    },
    get checks(): number {
      return checks;
    },
  };
}

test('coming back to the foreground asks for a new worker', async () => {
  const sw = fakeRegistered();
  const doc = fakeDoc();
  checkOnResume(sw, doc);
  assert.equal(sw.checks, 0, 'nothing happens until the app is resumed');
  doc.show('visible');
  // The check is not awaited by the handler, so let its promises settle.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sw.checks, 1);
});

test('going away does not ask', () => {
  // `visibilitychange` fires on the way out as well, and a backgrounded app
  // has no reason to spend a request.
  const sw = fakeRegistered();
  const doc = fakeDoc();
  checkOnResume(sw, doc);
  doc.show('hidden');
  assert.equal(sw.checks, 0);
});

test('a browser with no registration support is survivable', () => {
  const doc = fakeDoc();
  checkOnResume({ controller: {}, addEventListener(): void {} }, doc);
  assert.equal(doc.listeners, 0, 'no listener is even registered');
  checkOnResume(undefined, doc);
  assert.equal(doc.listeners, 0);
});
