import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  KindFolder,
  KindProject,
  KindTask,
  StatusActive,
  StatusDone,
  StatusDropped,
  StatusOnHold,
  parseTime,
} from '../task.ts';
import { Filter, filterFields, filterFromJSON } from './filter.ts';
import { AvailabilityAvailable, OrderDue, Scope } from './store.ts';

/**
 * everyFieldSet is a Filter with every field carrying a non-default value, so
 * that nothing can be omitted from the golden document below by accident.
 */
function everyFieldSet(): Filter {
  const at = (s: string): Date => parseTime(s);
  return new Filter({
    kinds: [KindFolder, KindProject, KindTask],
    statuses: [StatusActive, StatusOnHold, StatusDone, StatusDropped],
    availability: AvailabilityAvailable,
    flagged: true,
    scope: new Scope({
      parentID: '01J3',
      children: true,
      subtree: '01J4',
      inbox: true,
    }),
    tags: ['home', 'errand'],
    tagsAny: true,
    deferBefore: at('2026-01-01T00:00:00Z'),
    deferAfter: at('2026-01-02T00:00:00Z'),
    dueBefore: at('2026-01-03T00:00:00Z'),
    dueAfter: at('2026-01-04T00:00:00Z'),
    hasDue: true,
    reviewDueBefore: at('2026-01-05T00:00:00Z'),
    includeDeleted: true,
    onlyDeleted: true,
    order: OrderDue,
    limit: 25,
    // now is deliberately left out: it is never stored, because it is a clock
    // reading and not part of what was saved.
  });
}

/**
 * storedFilterGolden is the on-disk shape of a perspective's filter. It is a
 * literal and not a recomputation on purpose: a test that re-derives the
 * format cannot notice the format changing.
 */
const storedFilterGolden =
  `{"kinds":["folder","project","task"],` +
  `"statuses":["active","on_hold","done","dropped"],` +
  `"availability":"available","flagged":true,` +
  `"scope":{"parent_id":"01J3","children":true,"subtree":"01J4","inbox":true},` +
  `"tags":["home","errand"],"tags_any":true,` +
  `"defer_before":"2026-01-01T00:00:00Z","defer_after":"2026-01-02T00:00:00Z",` +
  `"due_before":"2026-01-03T00:00:00Z","due_after":"2026-01-04T00:00:00Z",` +
  `"has_due":true,"review_due_before":"2026-01-05T00:00:00Z",` +
  `"include_deleted":true,"only_deleted":true,"order":"due","limit":25}`;

// A Filter is the on-disk format of a saved perspective: savePerspective
// stores the JSON of it, and `tdo export` copies those bytes into a backup.
// Nothing else pinned that shape, so a renamed field or an edited key changed
// the meaning of every perspective already stored, with no error anywhere —
// and because every field here narrows a listing, the result of getting it
// wrong is a query that silently matches more than the user saved.
test('the stored filter format is fixed', () => {
  const encoded = JSON.stringify(everyFieldSet());
  assert.equal(
    encoded,
    storedFilterGolden,
    'the on-disk format of a saved perspective changed, so every perspective a user has already saved now means something else; this needs a migration of the stored rows, not a new golden string (PLAN.md §3.6)',
  );

  // The golden document above can only catch a field it contains. A field
  // added with an omit-when-unset rule and left unset would slip past it, so
  // the count is checked too: add a field, update everyFieldSet, and read the
  // paragraph on Filter before changing either.
  const fields = 18;
  assert.equal(
    filterFields.length,
    fields,
    `Filter has ${filterFields.length} fields and the golden format describes ${fields}; a field was added, renamed or removed, and the stored format moved with it`,
  );
  // filterFields is a list and not a count, so it can also be held to being
  // the actual fields: a stale list would defeat the check above.
  assert.deepEqual(
    Object.keys(new Filter()).sort(),
    [...filterFields].sort(),
    'filterFields no longer lists the fields a Filter has',
  );
});

// Whatever the format is, it has to survive the trip it is written for.
test('a stored filter round-trips unchanged', () => {
  const want = everyFieldSet();
  const got = filterFromJSON(JSON.stringify(want));
  assert.deepEqual(
    got,
    want,
    'a perspective must run as the query it was saved as, but it did not survive the round trip',
  );
});

// A key this binary does not know is refused rather than dropped. Every field
// of a Filter narrows a listing, so dropping one turns a saved query into a
// wider one: "flagged, not deferred" comes back as "everything", and the user
// acts on that list believing it is theirs. An error is visible; a wider
// answer is not.
test('an unknown key in a stored filter is refused rather than widened', () => {
  const stored = '{"flagged":true,"excludes_waiting":true}';

  let err: unknown;
  assert.throws(
    () => filterFromJSON(stored),
    (e: unknown) => {
      err = e;
      return true;
    },
    'a stored filter carrying a key this binary does not understand must be refused, not silently run as a wider query',
  );
  const message = (err as Error).message;
  for (const want of ['excludes_waiting', 'widen']) {
    assert.ok(
      message.includes(want),
      `the error must say what it found and why it matters; ${JSON.stringify(message)} does not mention ${JSON.stringify(want)}`,
    );
  }

  // The refusal is about unknown keys only: a filter with a key left out is a
  // filter that did not use it, which is ordinary.
  const sparse = filterFromJSON('{"flagged":true}');
  assert.equal(
    sparse.flagged,
    true,
    'the keys that are there must still be read',
  );
});
