// The router, over a real store.
//
// These tests are the answer to "does the PWA actually talk to a database",
// and they answer it without a browser and without touching anyone's Turso
// account: the store is `@todocloud/store-turso` pointed at the fake
// pipeline server in `packages/store-turso/src/fakeserver.test.ts`, which
// executes what it receives on an in-memory SQLite engine. So the SQL, the
// constraints and the ordering here are a real engine's, and the only thing
// faked is the hostname.
//
// Two notes on how this file reaches that fixture.
//
// It is imported by a relative path across a package boundary, which is not
// how this repository's source files reach each other — `@todocloud/...` and
// an `exports` map is. The fixture is a test file, so it is in no `exports`
// map, and the alternative is a second fake server. A fake of a protocol is
// exactly the thing not to have two of.
//
// Importing a `.test.ts` from a test file would run its tests twice. That
// file has none: it says so at the bottom, and its own two tests live in
// `turso.test.ts` for this reason.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import type { Store } from '@todocloud/core/store';

import { openStore } from '../../store-turso/src/fakeserver.test.ts';
import { Router } from './router.ts';

/** A fixed clock, so availability and every timestamp are the same every run. */
const now = new Date('2026-03-04T05:06:07Z');

/** TaskJSON is the part of the `TaskView` shape these tests read. */
interface TaskJSON {
  id: string;
  title: string;
  status: string;
  flagged: boolean;
  parent_id?: string | null;
  note?: string;
  tags?: string[];
  due_at?: string | null;
  available?: boolean | null;
}

/** Payload is the one envelope every endpoint answers with. */
interface Payload {
  tasks?: TaskJSON[];
  count?: number;
  repeated?: TaskJSON[];
  completed_with_last?: TaskJSON[];
  perspectives?: unknown[];
  tags?: unknown[];
  store?: string;
  now?: string;
  error?: { code: string; message: string };
}

/** newRouter opens a store against the fake server and wraps it. */
async function newRouter(t: TestContext): Promise<{ router: Router; st: Store }> {
  const { store } = await openStore(t);
  const router = new Router(store);
  router.now = () => now;
  return { router, st: store };
}

/** call drives one request the way `shim.ts` does, and decodes the answer. */
async function call(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: Payload }> {
  const res = await router.handle(
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
  );
  const text = await res.text();
  return { status: res.status, payload: text === '' ? {} : (JSON.parse(text) as Payload) };
}

/** add creates one inbox task and returns it. */
async function add(router: Router, title: string, extra: object = {}): Promise<TaskJSON> {
  const { status, payload } = await call(router, 'POST', '/api/tasks', { title, ...extra });
  assert.equal(status, 200, JSON.stringify(payload));
  const t = payload.tasks?.[0];
  assert.notEqual(t, undefined);
  return t as TaskJSON;
}

test('the state endpoint answers with the whole tree in one snapshot', async (t) => {
  const { router, st } = await newRouter(t);
  await add(router, 'Review the contract');

  const { status, payload } = await call(router, 'GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(payload.count, 1);
  assert.equal(payload.tasks?.[0]?.title, 'Review the contract');
  // The three slices the sidebar, the list and the inspector read, and the
  // clock the page answers "overdue" against — all from one response, so
  // they cannot contradict each other.
  assert.ok(Array.isArray(payload.perspectives));
  assert.ok(Array.isArray(payload.tags));
  assert.equal(payload.store, st.describe());
  assert.equal(payload.now, '2026-03-04T05:06:07Z');
});

test('a created task is the documented single-item envelope', async (t) => {
  const { router } = await newRouter(t);
  const { status, payload } = await call(router, 'POST', '/api/tasks', {
    title: 'Call the bank',
    note: 'about the transfer',
    tags: ['errand'],
    flagged: true,
    due_at: '2026-03-05',
  });

  assert.equal(status, 200);
  // `{"tasks":[…],"count":1}` — the shape `docs/agents.md` documents, not a
  // second one invented for a browser.
  assert.equal(payload.count, 1);
  assert.equal(payload.tasks?.length, 1);
  const created = payload.tasks?.[0];
  assert.equal(created?.title, 'Call the bank');
  assert.equal(created?.flagged, true);
  assert.deepEqual(created?.tags, ['errand']);
});

test('an edit goes through taskops and comes back as the stored task', async (t) => {
  const { router } = await newRouter(t);
  const created = await add(router, 'Draft the reply');

  const { status, payload } = await call(router, 'PATCH', `/api/tasks/${created.id}`, {
    title: 'Draft the reply to Ana',
    note: 'two paragraphs',
    flagged: true,
  });
  assert.equal(status, 200);
  assert.equal(payload.tasks?.[0]?.title, 'Draft the reply to Ana');
  assert.equal(payload.tasks?.[0]?.flagged, true);

  // And it is the store that says so, not the response.
  const state = await call(router, 'GET', '/api/state');
  assert.equal(state.payload.tasks?.[0]?.note, 'two paragraphs');
});

test('completing is the call tdo done makes, successors included', async (t) => {
  const { router } = await newRouter(t);
  const created = await add(router, 'Water the plants', { repeat: '3d' });

  const { status, payload } = await call(router, 'POST', `/api/tasks/${created.id}/done`, {});
  assert.equal(status, 200);
  assert.equal(payload.tasks?.[0]?.status, 'done');
  // The successor nobody asked for, reported rather than discovered later by
  // its absence. This is §3.4 having one answer across the two front ends.
  assert.equal(payload.repeated?.length, 1);
  assert.equal(payload.repeated?.[0]?.title, 'Water the plants');
  assert.notEqual(payload.repeated?.[0]?.id, created.id);
});

test('completing with no body at all is how the viewer sends it', async (t) => {
  const { router } = await newRouter(t);
  const created = await add(router, 'Take out the bins');

  // `fetch` sends no body for a request built without one, and
  // `optionalBody` has to read that as every default.
  const res = await router.handle('POST', `/api/tasks/${created.id}/done`, undefined);
  assert.equal(res.status, 200);
});

test('a status change refuses done, which has to go through /done', async (t) => {
  const { router } = await newRouter(t);
  const created = await add(router, 'Renew the lease');

  const held = await call(router, 'POST', `/api/tasks/${created.id}/status`, {
    status: 'on_hold',
  });
  assert.equal(held.status, 200);
  assert.equal(held.payload.tasks?.[0]?.status, 'on_hold');

  const done = await call(router, 'POST', `/api/tasks/${created.id}/status`, {
    status: 'done',
  });
  assert.equal(done.status, 400);
  assert.match(done.payload.error?.message ?? '', /\/done/);
});

test('a date is set and cleared the way an emptied field sends it', async (t) => {
  const { router } = await newRouter(t);
  const created = await add(router, 'Pay the invoice');

  const set = await call(router, 'POST', `/api/tasks/${created.id}/date`, {
    field: 'due',
    at: '2026-03-10',
  });
  assert.equal(set.status, 200);
  assert.ok((set.payload.tasks?.[0]?.due_at ?? '').startsWith('2026-03-10'));

  const cleared = await call(router, 'POST', `/api/tasks/${created.id}/date`, {
    field: 'due',
    at: '',
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.payload.tasks?.[0]?.due_at ?? null, null);

  const wrong = await call(router, 'POST', `/api/tasks/${created.id}/date`, {
    field: 'whenever',
    at: '2026-03-10',
  });
  assert.equal(wrong.status, 400);
});

test('a move resolves the parent instead of trusting the id', async (t) => {
  const { router } = await newRouter(t);
  const project = await add(router, 'Move house', { kind: 'project' });
  const task = await add(router, 'Book the van');

  const moved = await call(router, 'POST', `/api/tasks/${task.id}/move`, {
    parent_id: project.id,
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.payload.tasks?.[0]?.parent_id, project.id);

  // A parent the store does not know is a 404, not a row with a dangling
  // parent.
  const nowhere = await call(router, 'POST', `/api/tasks/${task.id}/move`, {
    parent_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  });
  assert.equal(nowhere.status, 404);
});

test('removing is a tombstone, and there is no purge here', async (t) => {
  const { router } = await newRouter(t);
  const created = await add(router, 'Cancel the trial');

  const removed = await call(router, 'DELETE', `/api/tasks/${created.id}`);
  assert.equal(removed.status, 200);

  // Gone from the tree the page is given, which is every status with
  // tombstones excluded.
  const state = await call(router, 'GET', '/api/state');
  assert.equal(state.payload.count, 0);
});

test('the failure classes map onto the status codes app.js reads', async (t) => {
  const { router } = await newRouter(t);
  const created = await add(router, 'Something');

  // An id that is not an id, and an id nothing holds.
  const notAnID = await call(router, 'PATCH', '/api/tasks/not-an-id', { title: 'x' });
  assert.equal(notAnID.status, 400);
  assert.equal(notAnID.payload.error?.code, 'usage');

  const missing = await call(router, 'PATCH', '/api/tasks/01ARZ3NDEKTSV4RRFFQ69G5FAV', {
    title: 'x',
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.error?.code, 'not_found');

  // A key the API does not know: refused, because an ignored key is a
  // half-applied edit reported as a success.
  const unknown = await call(router, 'PATCH', `/api/tasks/${created.id}`, { colour: 'red' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.payload.error?.message ?? '', /unknown field/);

  // An edit that changes nothing.
  const empty = await call(router, 'PATCH', `/api/tasks/${created.id}`, {});
  assert.equal(empty.status, 400);

  // A title-less create.
  const untitled = await call(router, 'POST', '/api/tasks', { title: '   ' });
  assert.equal(untitled.status, 400);
});

test('an unknown endpoint is 404 and a wrong method is 405', async (t) => {
  const { router } = await newRouter(t);

  const nowhere = await call(router, 'GET', '/api/nothing');
  assert.equal(nowhere.status, 404);
  assert.equal(nowhere.payload.error?.code, 'not_found');

  const wrong = await call(router, 'POST', '/api/state');
  assert.equal(wrong.status, 405);
  assert.equal(wrong.payload.error?.code, 'usage');
});

test('a body over the cap is cut, and the cut JSON is a usage error', async (t) => {
  const { router } = await newRouter(t);
  const huge = `{"title":"${'x'.repeat(1 << 21)}"}`;

  const res = await router.handle('POST', '/api/tasks', huge);
  assert.equal(res.status, 400);
});

test('two requests do not interleave', async (t) => {
  const { router } = await newRouter(t);
  await add(router, 'First');

  // The store is documented as safe for one caller at a time, and a browser
  // fires requests as fast as a key repeats. Ten creates at once must all
  // land, and the tree must hold exactly ten.
  await Promise.all(
    Array.from({ length: 10 }, (_v, i) => add(router, `Concurrent ${String(i)}`)),
  );
  const state = await call(router, 'GET', '/api/state');
  assert.equal(state.payload.count, 11);
});

test('a store that cannot be reached fails rather than pretending', async (t) => {
  const { router, st } = await newRouter(t);
  await st.close();

  const res = await call(router, 'GET', '/api/state');
  // 500 and the error envelope: the page shows the message. There is no
  // queue and no cached list, which is the decision recorded in `main.ts`.
  assert.equal(res.status, 500);
  assert.notEqual(res.payload.error?.message, undefined);
});
