// The Go package had no tests of its own, so these are new. They cover the
// pure decision logic of this file — what a parser accepts, what an edit
// refuses, what order it writes in — and not the provider behaviour the
// conformance suite in `@todocloud/store-testkit` already holds every store
// to.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  Fields,
  KeyPriority,
  KindFolder,
  KindProject,
  KindTask,
  RepeatDeferAnother,
  RepeatFixed,
  RepeatFromCompletion,
} from '../task.ts';
import {
  Draft,
  Edit,
  ErrInvalid,
  isInvalid,
  normalizeTags,
  parseMinutes,
  parseRepeat,
} from './edit.ts';
import { idA, now, task } from './testsupport.ts';

/** refuses asserts that fn throws an ErrInvalid whose message contains want. */
function refuses(fn: () => unknown, want: string, label?: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(isInvalid(err), `${label ?? want}: not an ErrInvalid: ${err}`);
    assert.match((err as Error).message, new RegExp(want), label);
    // The message is the sentinel's, then the detail, which is what
    // `fmt.Errorf("%w: %s", ErrInvalid, …)` produced.
    assert.ok((err as Error).message.startsWith(`${ErrInvalid.message}: `));
    return;
  }
  assert.fail(`${label ?? want}: expected a refusal`);
}

test('normalizeTags splits, trims and dedupes case-insensitively', () => {
  assert.deepEqual(normalizeTags(['home,  errand ', '', ' ,']), [
    'home',
    'errand',
  ]);
  // The first spelling wins and the order it was written in is kept, because
  // this is the list the user will see printed back.
  assert.deepEqual(normalizeTags(['Home', 'home', 'HOME', 'work']), [
    'Home',
    'work',
  ]);
  assert.deepEqual(normalizeTags([]), []);
});

test('an Edit with nothing in it is empty', () => {
  assert.equal(new Edit().empty(), true);
  assert.equal(new Edit({}).empty(), true);
});

test('every field makes an Edit non-empty, including the clearing ones', () => {
  // The whole point of the optional fields: clearing a value is a change, and
  // `tdo edit --note ""` must not be mistaken for an edit that was never made.
  const cases: Array<[string, Edit]> = [
    ['title', new Edit({ title: 'x' })],
    ['an emptied note', new Edit({ note: '' })],
    ['a zero estimate', new Edit({ estimatedMinutes: 0 })],
    ['an emptied tag set', new Edit({ tags: [] })],
    ['untag', new Edit({ untag: ['home'] })],
    ['priority zero', new Edit({ priority: 0 })],
    ['set', new Edit({ set: { energy: 'low' } })],
    ['unset', new Edit({ unset: ['energy'] })],
  ];
  for (const [name, e] of cases) {
    assert.equal(e.empty(), false, name);
  }
});

test('apply writes the fields it was given and leaves the rest', () => {
  const t = task(idA, { title: 'old' });
  t.setTags(['home', 'errand']);
  t.note = 'keep me';
  new Edit({ title: '  trimmed  ', estimatedMinutes: 25 }).apply(t);
  assert.equal(t.title, 'trimmed');
  assert.equal(t.estimatedMinutes, 25);
  assert.equal(t.note, 'keep me');
  assert.deepEqual(t.tags, ['errand', 'home']);
});

test('tags replaces the whole set and untag removes one of several', () => {
  const t = task(idA);
  t.setTags(['Home', 'errand', 'work']);
  new Edit({ untag: ['HOME,work'] }).apply(t);
  // Folded case-insensitively, and the comma spelling of a tag list is
  // accepted here too because normalizeTags handles both sides.
  assert.deepEqual(t.tags, ['errand']);

  new Edit({ tags: ['phone', 'Phone', ' '] }).apply(t);
  assert.deepEqual(t.tags, ['phone']);
});

test('apply orders the sugar, then set, then unset', () => {
  const t = task(idA);
  // The more explicit instruction wins when a key is named twice: unset runs
  // last, so naming a key in both removes it.
  new Edit({ set: { energy: 'low', place: 'desk' }, unset: ['energy'] }).apply(
    t,
  );
  assert.equal(Fields.string(t.fields, 'energy'), undefined);
  assert.equal(Fields.string(t.fields, 'place'), 'desk');
});

test('priority goes into the open map and is range-checked', () => {
  const t = task(idA);
  new Edit({ priority: 3 }).apply(t);
  assert.equal(Fields.int(t.fields, KeyPriority), 3);
  for (const bad of [-1, 4, 99]) {
    refuses(
      () => new Edit({ priority: bad }).apply(task(idA)),
      `priority must be between 0 and 3, got ${bad}`,
    );
  }
});

test('a reserved field name is refused for both set and unset', () => {
  refuses(
    () => new Edit({ set: { id: 'x' } }).apply(task(idA)),
    'field "id" is reserved and cannot be set',
  );
  refuses(
    () => new Edit({ unset: ['status'] }).apply(task(idA)),
    'field "status" is reserved and cannot be unset',
  );
  // "done" is derived rather than stored and is reserved all the same, which
  // is the case a shadowing field would make invisible in the flattened JSON.
  refuses(
    () => new Edit({ set: { done: true } }).apply(task(idA)),
    'field "done" is reserved and cannot be set',
  );
  refuses(
    () => new Edit({ unset: ['  '] }).apply(task(idA)),
    'a field to remove needs a name',
  );
});

test('two fields in one request are written in a fixed order', () => {
  // Go sorted the keys so that a failure on one of them is reproducible
  // whichever order the caller built the map in. JavaScript objects keep
  // insertion order, so the sort is what makes two differently-built requests
  // agree — and it is why the refusal below names "id" and not "zz".
  for (const set of [
    { zz: 1, id: 'x' },
    { id: 'x', zz: 1 },
  ]) {
    refuses(
      () => new Edit({ set }).apply(task(idA)),
      'field "id" is reserved',
      JSON.stringify(set),
    );
  }
});

test('a refused edit leaves the task it was handed as it was found', () => {
  // taskops.apply hands over a clone for exactly this reason, but the promise
  // only holds if the failure happens before the fields that would survive
  // it. A reserved key sorted after a good one is the case that tells them
  // apart.
  const t = task(idA, { title: 'before' });
  const stored = t.clone();
  refuses(
    () =>
      new Edit({ title: 'after', set: { id: 'x', aa: 1 } }).apply(t),
    'field "id" is reserved',
  );
  // The title and the earlier field did land: this is a clone, and the caller
  // discards it. The assertion records that, so that a future change which
  // starts relying on `apply` being atomic has to change this test too.
  assert.equal(t.title, 'after');
  assert.equal(Fields.int(t.fields, 'aa'), 1);
  assert.equal(stored.title, 'before');
});

test('a Draft builds a validated task', () => {
  const t = new Draft({
    kind: KindTask,
    title: '  write the report  ',
    tags: ['Work,work', 'desk'],
    priority: 2,
    estimatedMinutes: 30,
    note: 'two pages',
  }).build(idA, now);
  assert.equal(t.id, idA);
  assert.equal(t.title, 'write the report');
  assert.deepEqual(t.tags, ['desk', 'Work']);
  assert.equal(Fields.int(t.fields, KeyPriority), 2);
  assert.equal(t.estimatedMinutes, 30);
  assert.equal(t.createdAt.getTime(), now.getTime());
});

test('a repeating draft names its own series', () => {
  const t = new Draft({
    kind: KindTask,
    title: 'water the plants',
    repeat: { method: RepeatFixed, every: '1w' },
  }).build(idA, now);
  // The first instance names the series, so a successor needs no second
  // generator.
  assert.equal(t.seriesID, idA);
});

test('a draft that would not validate is refused, not stored', () => {
  refuses(
    () => new Draft({ kind: KindTask, title: '   ' }).build(idA, now),
    'title must not be empty',
  );
  refuses(
    () => new Draft({ kind: 'note', title: 'x' }).build(idA, now),
    'kind',
  );
  // The refusal happens before validate when the fields are the problem.
  refuses(
    () =>
      new Draft({ kind: KindTask, title: 'x', priority: 7 }).build(idA, now),
    'priority must be between 0 and 3',
  );
});

test('a folder draft is a folder, and a project draft a project', () => {
  for (const kind of [KindFolder, KindProject]) {
    const t = new Draft({ kind, title: kind }).build(idA, now);
    assert.equal(t.kind, kind);
  }
});

test('parseMinutes reads a bare number of minutes', () => {
  assert.equal(parseMinutes('25'), 25);
  assert.equal(parseMinutes('0'), 0);
  assert.equal(parseMinutes(' 90 '), 90);
  assert.equal(parseMinutes('+5'), 5);
  refuses(() => parseMinutes('-5'), 'must not be negative');
});

test('parseMinutes reads the duration spellings', () => {
  const cases: Array<[string, number]> = [
    ['25m', 25],
    ['2h', 120],
    ['1h30m', 90],
    ['1H30M', 90],
    ['1.5h', 90],
    // Truncated to whole minutes, as Go's int(d / time.Minute) was.
    ['90s', 1],
    ['59s', 0],
    ['0h', 0],
  ];
  for (const [raw, want] of cases) {
    assert.equal(parseMinutes(raw), want, raw);
  }
});

test('parseMinutes refuses what is not a duration', () => {
  for (const raw of ['', '   ', 'soon', '1h30', '25 m', 'm', '1x', '.h', '-1h']) {
    refuses(
      () => parseMinutes(raw),
      raw.trim() === ''
        ? 'expected a duration'
        : 'is not a duration; write it as 25m, 2h or 1h30m',
      JSON.stringify(raw),
    );
  }
});

test('parseRepeat defaults to the calendar schedule', () => {
  // A repeat with no method named follows the previous instance's dates,
  // which is what "every Monday" means.
  assert.deepEqual(parseRepeat('1w'), { method: RepeatFixed, every: '1w' });
  assert.deepEqual(parseRepeat('  3d '), { method: RepeatFixed, every: '3d' });
});

test('parseRepeat recognises a method only by name at the end', () => {
  assert.deepEqual(parseRepeat('1w:from_completion'), {
    method: RepeatFromCompletion,
    every: '1w',
  });
  assert.deepEqual(parseRepeat('1mo:defer_another'), {
    method: RepeatDeferAnother,
    every: '1mo',
  });
  // The interval spelling carries its own colon, so the trailing word is part
  // of the interval unless it is one of the three methods.
  assert.deepEqual(parseRepeat('1mo:last-friday'), {
    method: RepeatFixed,
    every: '1mo:last-friday',
  });
  assert.deepEqual(parseRepeat('1mo:last-friday:from_completion'), {
    method: RepeatFromCompletion,
    every: '1mo:last-friday',
  });
});

test('parseRepeat refuses an interval it cannot read', () => {
  refuses(() => parseRepeat('  '), 'a repeat needs an interval');
  refuses(() => parseRepeat('weekly'), 'must start with a number');
  refuses(() => parseRepeat('0w'), 'must repeat at least once');
  refuses(() => parseRepeat('1q'), 'expected d, w, mo or y');
  // A method with no interval in front of it is not an interval either.
  refuses(() => parseRepeat(':from_completion'), 'an interval must say how often');
  refuses(() => parseRepeat('1w:last-tuesday'), 'calendar day only makes sense');
});
