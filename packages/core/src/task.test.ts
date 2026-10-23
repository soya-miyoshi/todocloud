// The Go suite for internal/task, ported case for case. Three Go tests had to
// change shape rather than meaning, and each says so where it stands:
// the int-versus-float64 ones, because JavaScript has a single number type,
// and the invalid-UTF-8 one, because a JavaScript string is UTF-16 and
// JSON.stringify is well-formed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ErrEmptyTitle,
  Fields,
  KeyAvailable,
  KeyBlockedBy,
  KeyCompletedAt,
  KeyCompletedByChildren,
  KeyCreatedAt,
  KeyDeferAt,
  KeyDeletedAt,
  KeyDone,
  KeyDroppedAt,
  KeyDueAt,
  KeyEstimatedMinutes,
  KeyFlagged,
  KeyID,
  KeyKind,
  KeyLastReviewedAt,
  KeyNextReview,
  KeyNote,
  KeyParentID,
  KeyPosition,
  KeyPriority,
  KeyRepeat,
  KeyReviewInterval,
  KeySequential,
  KeySeriesID,
  KeyStatus,
  KeyTags,
  KeyWaitsOn,
  KeyTitle,
  KeyUpdatedAt,
  KindFolder,
  KindProject,
  KindTask,
  Kinds,
  RepeatFixed,
  RepeatFromCompletion,
  Reserved,
  ReservedKeys,
  StatusActive,
  StatusDone,
  StatusDropped,
  StatusOnHold,
  Task,
  formatTime,
  kindCanContain,
  newTask,
  parseDue,
  parseTime,
  parseValue,
  taskParse,
  zeroTime,
  type JSONObject,
  type JSONValue,
  type Kind,
  type Status,
} from './task.ts';

function mustTime(s: string): Date {
  return parseTime(s);
}

function sample(): Task {
  const at = mustTime('2026-10-20T04:11:00Z');
  const task = newTask('01J3ZQK8V9XW5S6R7T8Y9Z0A1B', KindTask, 'Pay the invoice', at);
  task.fields = { [KeyPriority]: 2, client: 'acme' };
  task.setTags(['finance']);
  return task;
}

function roundTripJSON(task: Task): JSONObject {
  return JSON.parse(JSON.stringify(task)) as JSONObject;
}

function asObject(v: JSONValue | undefined): JSONObject {
  assert.ok(v !== null && typeof v === 'object' && !Array.isArray(v), 'expected an object');
  return v;
}

test('the JSON shape is the documented one', () => {
  const task = sample();
  task.dueAt = mustTime('2026-11-01T00:00:00Z');
  const got = roundTripJSON(task);

  assert.deepStrictEqual(got, {
    id: '01J3ZQK8V9XW5S6R7T8Y9Z0A1B',
    kind: 'task',
    title: 'Pay the invoice',
    parent_id: null,
    position: 0,
    status: 'active',
    flagged: false,
    sequential: false,
    completed_by_children: false,
    defer_at: null,
    due_at: '2026-11-01T00:00:00Z',
    estimated_minutes: 0,
    note: null,
    repeat: null,
    series_id: null,
    review_interval: null,
    last_reviewed_at: null,
    created_at: '2026-10-20T04:11:00Z',
    updated_at: '2026-10-20T04:11:00Z',
    completed_at: null,
    dropped_at: null,
    deleted_at: null,
    tags: ['finance'],
    done: false,
    priority: 2,
    client: 'acme',
  });

  // Go's encoding/json writes the keys of a map in sorted order, so the bytes
  // of the documented shape depend on this and not only on the values.
  const keys = Object.keys(got);
  assert.deepStrictEqual(keys, [...keys].sort(), 'the keys must be written sorted');
});

// done is derived from the status, so that the common question stays one key
// for a caller that does not care about the other three states.
test('done is derived from the status', () => {
  const task = sample();
  for (const [status, want] of [
    [StatusActive, false],
    [StatusOnHold, false],
    [StatusDropped, false],
    [StatusDone, true],
  ] as [Status, boolean][]) {
    task.status = status;
    assert.strictEqual(
      roundTripJSON(task)['done'],
      want,
      `status ${status} must render done as ${want}`,
    );
  }
});

// Losslessness is what `tdo export | tdo import` rests on: a field this binary
// has never heard of must come back identical in meaning.
test('a round trip preserves fields this binary does not know', () => {
  const at = mustTime('2026-10-20T04:11:00Z');
  const done = mustTime('2026-10-21T09:00:00Z');
  const original = newTask('01J3ZQK8V9XW5S6R7T8Y9Z0A1B', KindTask, 'Ship v0.1', at);
  original.status = StatusDone;
  original.updatedAt = done;
  original.completedAt = done;
  original.parentID = '01J3ZQK8V9XW5S6R7T8Y9Z0A1C';
  original.position = 7;
  original.flagged = true;
  original.sequential = true;
  original.completedByChildren = true;
  original.deferAt = at;
  original.dueAt = done;
  original.estimatedMinutes = 45;
  original.note = 'two lines\nof note';
  original.repeat = { method: RepeatFromCompletion, every: '1mo:last-friday' };
  original.seriesID = '01J3ZQK8V9XW5S6R7T8Y9Z0A1D';
  original.reviewInterval = undefined;
  original.setTags(['release', 'go']);
  original.fields = {
    [KeyPriority]: 3,
    client: 'acme',
    estimate: 5,
    ratio: 0.25,
    blocked: false,
    links: ['https://example.com', 7],
    meta: { owner: 'me', rounds: 2 },
  };

  const back = taskParse(JSON.stringify(original));

  assert.deepStrictEqual(
    back.fields,
    original.fields,
    'user-defined fields changed across a round trip',
  );
  assert.deepStrictEqual(back.tags, original.tags, 'tags changed across a round trip');
  assert.deepStrictEqual(back.repeat, original.repeat, 'repeat changed across a round trip');
  for (const [name, got, want] of [
    ['id', back.id, original.id],
    ['kind', back.kind, original.kind],
    ['status', back.status, original.status],
    ['parent_id', back.parentID, original.parentID],
    ['position', back.position, original.position],
    ['flagged', back.flagged, original.flagged],
    ['sequential', back.sequential, original.sequential],
    ['completed_by_children', back.completedByChildren, original.completedByChildren],
    ['estimated_minutes', back.estimatedMinutes, original.estimatedMinutes],
    ['note', back.note, original.note],
    ['series_id', back.seriesID, original.seriesID],
  ] as [string, unknown, unknown][]) {
    assert.strictEqual(got, want, `${name} changed across a round trip`);
  }
  assert.ok(back.completedAt !== undefined, 'completed_at was dropped');
  assert.strictEqual(back.completedAt.getTime(), done.getTime(), 'completed_at moved');
});

// A document a human wrote by hand, or one from before a key existed, must
// land on a usable task rather than on an invalid one.
test('a document missing kind or status lands on the defaults', () => {
  const raw =
    '{"id":"01J3ZQK8V9XW5S6R7T8Y9Z0A1B","title":"x","created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"}';
  const back = taskParse(raw);
  assert.strictEqual(back.kind, KindTask, 'a document with no kind must read as a task');
  assert.strictEqual(back.status, StatusActive, 'a document with no status must read as active');
  assert.strictEqual(back.validate(), undefined, 'the result must be valid');
});

test('a derived key is not read back as a user field', () => {
  const raw =
    '{"id":"01J3","title":"x","status":"active","done":true,"available":false,"created_at":"2026-10-20T04:11:00Z","updated_at":"2026-10-20T04:11:00Z"}';
  const back = taskParse(raw);
  assert.deepStrictEqual(
    back.fields,
    {},
    'a derived key must be discarded on the way in, not stored as a user-defined field',
  );
  assert.strictEqual(
    back.status,
    StatusActive,
    'the status column decides, not the derived done',
  );
});

test('validate rejects what no provider could store', async (t) => {
  const at = mustTime('2026-10-20T04:11:00Z');
  const cases: [name: string, mutate: (task: Task) => void, wantErr: boolean][] = [
    ['valid', () => {}, false],
    ['empty title', (task) => void (task.title = ''), true],
    ['blank title', (task) => void (task.title = '   '), true],
    ['missing id', (task) => void (task.id = ''), true],
    ['unknown kind', (task) => void (task.kind = 'wish'), true],
    ['unknown status', (task) => void (task.status = 'maybe'), true],
    [
      'a folder is never completed',
      (task) => {
        task.kind = KindFolder;
        task.status = StatusDone;
      },
      true,
    ],
    ['its own parent', (task) => void (task.parentID = task.id), true],
    [
      'missing timestamps',
      (task) => {
        task.createdAt = zeroTime();
        task.updatedAt = zeroTime();
      },
      true,
    ],
    ['negative estimate', (task) => void (task.estimatedMinutes = -1), true],
    ['reserved field name', (task) => void (task.fields[KeyStatus] = 'active'), true],
    ['derived field name is reserved too', (task) => void (task.fields[KeyDone] = true), true],
    ['empty field name', (task) => void (task.fields[''] = 1), true],
    ['priority too high', (task) => void (task.fields[KeyPriority] = 4), true],
    ['priority at the top of the range', (task) => void (task.fields[KeyPriority] = 3), false],
    [
      'a repeat with no interval',
      (task) => void (task.repeat = { method: RepeatFixed, every: '' }),
      true,
    ],
    [
      'a repeat with an unknown method',
      (task) => void (task.repeat = { method: 'sometimes', every: '1w' }),
      true,
    ],
    [
      'a valid repeat',
      (task) => void (task.repeat = { method: RepeatFixed, every: '1w' }),
      false,
    ],
    [
      'a review interval on a task',
      (task) => void (task.reviewInterval = { every: '1w' }),
      true,
    ],
    [
      'a review interval on a project',
      (task) => {
        task.kind = KindProject;
        task.reviewInterval = { every: '1w' };
      },
      false,
    ],
    ['an empty tag', (task) => void (task.tags = [' ']), true],
    ['unknown field is allowed', (task) => void (task.fields['whatever'] = [1, 'two']), false],
  ];
  for (const [name, mutate, wantErr] of cases) {
    await t.test(name, () => {
      const task = newTask('01J3ZQK8V9XW5S6R7T8Y9Z0A1B', KindTask, 'x', at);
      mutate(task);
      const err = task.validate();
      assert.strictEqual(err !== undefined, wantErr, `validate() = ${String(err)}`);
    });
  }
});

test('an empty title is reported as ErrEmptyTitle', () => {
  const task = newTask('01J3', KindTask, '  ', mustTime('2026-10-20T04:11:00Z'));
  assert.strictEqual(task.validate(), ErrEmptyTitle);
});

test('setStatus keeps the timestamps honest', () => {
  const at = mustTime('2026-10-20T04:11:00Z');
  const now = mustTime('2026-10-21T09:00:00Z');
  const task = newTask('01J3ZQK8V9XW5S6R7T8Y9Z0A1B', KindTask, 'x', at);

  task.setStatus(StatusDone, now);
  assert.ok(task.done(), 'after setStatus(done) the task is done');
  assert.strictEqual(task.completedAt?.getTime(), now.getTime());
  assert.strictEqual(task.updatedAt.getTime(), now.getTime());

  // A no-op must not move updated_at, so a repeated `tdo done` is harmless.
  const later = new Date(now.getTime() + 3600_000);
  task.setStatus(StatusDone, later);
  assert.strictEqual(task.updatedAt.getTime(), now.getTime(), 'updated_at must not move');

  task.setStatus(StatusDropped, later);
  assert.strictEqual(
    task.completedAt,
    undefined,
    'dropping a completed task must move the timestamp with it',
  );
  assert.strictEqual(task.droppedAt?.getTime(), later.getTime());

  task.setStatus(StatusActive, new Date(later.getTime() + 3600_000));
  assert.strictEqual(task.completedAt, undefined, 'reopening must clear completed_at');
  assert.strictEqual(task.droppedAt, undefined, 'reopening must clear dropped_at');
});

test('tags are a set compared case-insensitively', () => {
  const task = sample();
  task.setTags(['Home', 'home', ' errand ', '', 'Errand']);
  assert.deepStrictEqual(
    task.tags,
    ['errand', 'Home'],
    'tags must be trimmed, deduplicated case-insensitively in the spelling first typed, and sorted',
  );
  assert.ok(task.hasTag('HOME'), 'hasTag must compare case-insensitively');
  assert.ok(!task.hasTag('work'), 'hasTag must not invent a tag');
});

test('the containment table is what PLAN says it is', () => {
  const want: [Kind, Kind[]][] = [
    [KindFolder, [KindFolder, KindProject]],
    [KindProject, [KindTask]],
    [KindTask, [KindTask]],
  ];
  for (const [parent, allowed] of want) {
    for (const child of Kinds()) {
      const ok = allowed.includes(child);
      assert.strictEqual(
        kindCanContain(parent, child),
        ok,
        `a ${parent} ${ok ? 'must' : 'must not'} contain a ${child}`,
      );
    }
  }
});

test('inbox is the absence of a parent', () => {
  const at = mustTime('2026-10-20T04:11:00Z');
  const loose = newTask('01J3', KindTask, 'loose', at);
  assert.ok(loose.inbox(), 'a task with no parent is in the inbox');
  loose.parentID = '01J4';
  assert.ok(!loose.inbox(), 'a task with a parent is not in the inbox');
  const project = newTask('01J5', KindProject, 'a project', at);
  assert.ok(
    !project.inbox(),
    'a top-level project is at the top level, which is not the inbox',
  );
  assert.ok(
    !newTask('01J6', KindFolder, 'f', at).actionable(),
    'a folder is never actionable',
  );
});

test('clone is deep', () => {
  const original = sample();
  original.fields['meta'] = { owner: 'me' };
  original.repeat = { method: RepeatFixed, every: '1w' };
  const clone = original.clone();

  clone.title = 'changed';
  clone.fields[KeyPriority] = 1;
  asObject(clone.fields['meta'])['owner'] = 'someone else';
  clone.tags[0] = 'changed';
  assert.ok(clone.repeat !== undefined);
  clone.repeat.every = '2w';
  clone.createdAt.setUTCFullYear(1999);

  assert.notStrictEqual(original.title, clone.title, 'clone shares the title');
  assert.strictEqual(Fields.priority(original.fields), 2, 'original priority changed');
  assert.strictEqual(
    asObject(original.fields['meta'])['owner'],
    'me',
    'nested map was shared',
  );
  assert.strictEqual(original.tags[0], 'finance', 'tags were shared');
  assert.strictEqual(original.repeat.every, '1w', 'repeat was shared');
  assert.strictEqual(
    formatTime(original.createdAt),
    '2026-10-20T04:11:00Z',
    'a Date is mutable, so clone must copy it',
  );
});

test('every stored and derived name is reserved', () => {
  for (const key of [
    KeyID,
    KeyKind,
    KeyTitle,
    KeyParentID,
    KeyPosition,
    KeyStatus,
    KeyFlagged,
    KeySequential,
    KeyCompletedByChildren,
    KeyDeferAt,
    KeyDueAt,
    KeyEstimatedMinutes,
    KeyNote,
    KeyRepeat,
    KeySeriesID,
    KeyReviewInterval,
    KeyLastReviewedAt,
    KeyCreatedAt,
    KeyUpdatedAt,
    KeyCompletedAt,
    KeyDroppedAt,
    KeyDeletedAt,
    KeyTags,
    KeyDone,
    KeyAvailable,
    KeyBlockedBy,
    KeyNextReview,
    KeyWaitsOn,
  ]) {
    assert.ok(
      Reserved(key),
      `Reserved(${key}) = false: a user field of that name would shadow a required or derived one`,
    );
  }
  for (const key of [KeyPriority, 'client', 'due', 'notes']) {
    assert.ok(!Reserved(key), `Reserved(${key}) = true, want false: it is an ordinary open field`);
  }
  assert.strictEqual(ReservedKeys().length, 28);
  assert.deepStrictEqual(ReservedKeys(), [...ReservedKeys()].sort(), 'ReservedKeys is sorted');
});

// The accessors are the only place the variance of JSON-sourced values is
// handled, so they are tested against every form a provider can hand back.
// Go's int, int64, float64 and json.Number cases are one case here, because
// JavaScript has a single number type.
test('Fields.int', async (t) => {
  const cases: [name: string, value: JSONValue | undefined, want: number | undefined][] = [
    ['number', 3, 3],
    ['a whole number out of JSON', 3.0, 3],
    ['a fraction truncates, as the Go int conversion did', 3.9, 3],
    ['string, as Firestore REST returns integers', '3', 3],
    ['non-numeric string', 'high', undefined],
    ['bool', true, undefined],
    ['absent', undefined, undefined],
  ];
  for (const [name, value, want] of cases) {
    await t.test(name, () => {
      const f: Fields = {};
      if (value !== undefined) {
        f['k'] = value;
      }
      assert.strictEqual(Fields.int(f, 'k'), want);
    });
  }
});

test('Fields.strings', async (t) => {
  const cases: [name: string, value: JSONValue, want: string[] | undefined][] = [
    ['a list of strings', ['a', 'b'], ['a', 'b']],
    ['a mixed list is stringified', ['a', 2], ['a', '2']],
    ['a lone string is a one-element list', 'a', ['a']],
    // Go returned (nil, true) here: an empty list, and yes it was a list.
    // undefined already means "not a list", so the empty list is [].
    ['empty string is an empty list', '', []],
    ['number', 3, undefined],
  ];
  for (const [name, value, want] of cases) {
    await t.test(name, () => {
      assert.deepStrictEqual(Fields.strings({ k: value }, 'k'), want);
    });
  }
});

test('Fields.bool', () => {
  const cases: [value: JSONValue, want: boolean | undefined][] = [
    [true, true],
    ['true', true],
    ['false', false],
    ['yes', undefined],
    [1, undefined],
  ];
  for (const [value, want] of cases) {
    assert.strictEqual(Fields.bool({ k: value }, 'k'), want, `bool(${String(value)})`);
  }
});

test('priority defaults to zero', () => {
  assert.strictEqual(Fields.priority({}), 0, 'priority is 0 when unset');
  assert.strictEqual(
    Fields.priority({ [KeyPriority]: '2' }),
    2,
    'a provider may hand an integer back as a string',
  );
});

test('normalize', () => {
  // In Go every number here arrived as a json.Number and normalize chose its
  // Go type; the equivalent input in JavaScript is already a number, so what
  // is left to test is that normalize keeps every value as it was and still
  // settles priority, which a provider may send as a string.
  const f: Fields = {
    [KeyPriority]: '2',
    [KeyTags]: ['a', 'b'],
    estimate: 5,
    ratio: 0.25,
    whole: 7,
    nested: { rounds: 2 },
    list: [1, 'two'],
  };
  Fields.normalize(f);

  assert.deepStrictEqual(f, {
    [KeyPriority]: 2,
    tags: ['a', 'b'],
    estimate: 5,
    ratio: 0.25,
    whole: 7,
    nested: { rounds: 2 },
    list: [1, 'two'],
  });
});

// Go kept a whole float past int64's range as a float64 rather than convert
// it, because the conversion is undefined there and would silently change the
// number. JavaScript has one number type and no such conversion, so the value
// is simply carried through; what the Go test protected is pinned here as the
// number coming back bit for bit.
test('normalize leaves values past int64 alone', () => {
  const justPastMax = 2 ** 63;
  const justPastMin = -(2 ** 64);
  const f: Fields = { high: justPastMax, low: justPastMin, min: -(2 ** 63) };
  Fields.normalize(f);

  assert.strictEqual(f['high'], justPastMax, '2^63 must come back unchanged');
  assert.strictEqual(f['low'], justPastMin, '-2^64 must come back unchanged');
  assert.strictEqual(f['min'], -(2 ** 63), '-2^63 must come back unchanged');
});

test('parseValue', async (t) => {
  const cases: [input: string, want: JSONValue][] = [
    ['3', 3],
    ['0', 0],
    ['-2', -2],
    ['3.5', 3.5],
    ['5.0', 5],
    ['true', true],
    ['FALSE', false],
    ['null', null],
    ['acme', 'acme'],
    ['3.0.1', '3.0.1'],
    ['', ''],
    ['["a","b"]', ['a', 'b']],
    ['{"owner":"me","rounds":2}', { owner: 'me', rounds: 2 }],
    ['{"broken":', '{"broken":'],
    ['  spaced  ', '  spaced  '],
  ];
  for (const [input, want] of cases) {
    await t.test(input === '' ? '(empty)' : input, () => {
      assert.deepStrictEqual(parseValue(input), want);
    });
  }
});

test('parseDue', () => {
  for (const input of ['2026-11-01', '2026-11-01T10:00:00Z', '2026-11-01T10:00:00+09:00']) {
    assert.doesNotThrow(() => parseDue(input), `parseDue(${input}) must be accepted`);
  }
  for (const input of ['', 'next tuesday', '2026-13-01', '01/11/2026']) {
    assert.throws(() => parseDue(input), `parseDue(${input}) must be rejected`);
  }
});

test('format and parse time are UTC', () => {
  const v = parseTime('2026-11-01T10:00:00+09:00');
  assert.strictEqual(formatTime(v), '2026-11-01T01:00:00Z', 'formatTime must write the UTC form');
  assert.throws(
    () => parseTime('2026-11-01'),
    'parseTime must reject a date-only value',
  );
});

test('set removes on null', () => {
  const f: Fields = { k: 'v' };
  Fields.set(f, 'k', null);
  assert.ok(!Object.hasOwn(f, 'k'), 'set(key, null) kept the key');
});

test('keys are sorted', () => {
  assert.deepStrictEqual(Fields.keys({ c: 1, a: 2, b: 3 }), ['a', 'b', 'c']);
});

// parseValue reads whatever an agent or a user typed after `--set key=`, so it
// is the widest untrusted surface in the command layer. Two invariants matter:
// the result is always one of the JSON-shaped types the rest of the CLI knows
// how to store, and storing it has to be lossless, which means it must survive
// a JSON round trip followed by normalize.
//
// Go ran this as a fuzz target; `node --test` has no fuzzer, so the seed
// corpus is the table and the invariants are unchanged.
test('parseValue survives a store round trip for every seed', async (t) => {
  const seeds = [
    '',
    ' ',
    '\t\n',
    'true',
    'false',
    'TRUE',
    'False',
    'null',
    'NULL',
    '0',
    '-1',
    '42',
    '007',
    '3.5',
    '-0.0',
    '1e3',
    '1e400',
    '5.0',
    '9223372036854775807',
    '99999999999999999999',
    'NaN',
    'Inf',
    '+Inf',
    '-Inf',
    '9999999999999999.0000',
    '1e21',
    '-9007199254740993.0',
    '3.0.1',
    '2026-11-01',
    'acme',
    '["a","b"]',
    '[1,2,3]',
    '[]',
    '[',
    '[1,',
    '[{"a":1}]',
    '{"owner":"a","k":1}',
    '{}',
    '{',
    '{"a":',
    '{"a":{"b":{"c":[1,2,{"d":3.5}]}}}',
    '"quoted"',
    "'; DROP TABLE tasks; --",
    '%s',
    '{{.}}',
    '../../etc/passwd',
    'a\u0000b',
    '\ud800',
    '\u001b[31mred\u001b[0m',
    'A'.repeat(10000),
    '  padded  ',
  ];

  for (const raw of seeds) {
    await t.test(JSON.stringify(raw).slice(0, 40), () => {
      const v = parseValue(raw);
      assertJSONShape(v);

      const before: Fields = { v };
      Fields.normalize(before);
      const encoded = JSON.stringify(before);
      const decoded = JSON.parse(encoded) as JSONObject;
      const after: Fields = { ...decoded };
      Fields.normalize(after);
      // The property that matters for `tdo export | tdo import` is that the
      // encoding is stable. In Go the Go type could still differ across the
      // trip, because normalize and the decoder disagreed on large whole
      // floats; here there is one number type, so stability of the encoding is
      // stability of the value, and normalize is a no-op on what it reads back.
      assert.strictEqual(
        JSON.stringify(after),
        encoded,
        `parseValue(${raw.slice(0, 40)}) does not survive a JSON round trip`,
      );
      assert.deepStrictEqual(after, decoded, 'normalize changed a decoded value');
    });
  }
});

// assertJSONShape fails unless v is one of the types the model stores.
function assertJSONShape(v: JSONValue): void {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') {
    return;
  }
  if (typeof v === 'number') {
    assert.ok(Number.isFinite(v), `parseValue produced ${v}, which JSON cannot represent`);
    return;
  }
  if (Array.isArray(v)) {
    for (const e of v) {
      assertJSONShape(e);
    }
    return;
  }
  assert.strictEqual(typeof v, 'object', 'parseValue produced a value JSON cannot store');
  for (const e of Object.values(v)) {
    assertJSONShape(e);
  }
}

// Go's counterpart to this pinned a loss: a string holding bytes that are not
// UTF-8 was kept as typed, but encoding/json substituted U+FFFD for them, so
// what came back out of a store was not what went in. A JavaScript string is
// UTF-16 and JSON.stringify is well-formed — a lone surrogate is escaped as
// \udXXX and JSON.parse restores it — so the equivalent input is lossless
// here. Pinned so that a change in either direction is noticed.
test('parseValue keeps a lone surrogate, which the JSON round trip also keeps', () => {
  const raw = 'bad 𐀀\ud800 bytes';
  const v = parseValue(raw);
  assert.strictEqual(v, raw, 'parseValue must keep the string unchanged');

  const back = JSON.parse(JSON.stringify({ v })) as JSONObject;
  assert.strictEqual(back['v'], raw, 'the JSON round trip must keep it too');
});

// A whole number is stored as a number whether it came from the command line
// or from a provider, and a value too large for an exact integer stays the
// nearest number on both paths. normalize's purpose is that a task read back
// compares equal to one built in memory, so the two paths have to agree.
//
// In Go the agreement was about the Go type — int versus float64 — and the
// range guard that decided it. Here there is one number type, so what is
// checked is that the value itself is identical across the trip, including for
// the inputs that sat on the Go boundary.
test('normalize agrees with the decoder on large whole numbers', async (t) => {
  for (const raw of [
    '9999999999999999.0000', // whole, and inside what Go called int64's range
    '5.0',
    '9007199254740992', // 2^53, still an exact integer
    '9223372036854775807', // the largest int64, not exactly representable
    '1e30', // whole, but beyond int64
    '3.5',
  ]) {
    await t.test(raw, () => {
      const v = parseValue(raw);
      assert.strictEqual(typeof v, 'number', `parseValue(${raw}) must be a number`);

      const encoded = JSON.stringify({ v });
      const back: Fields = { ...(JSON.parse(encoded) as JSONObject) };
      Fields.normalize(back);
      assert.strictEqual(
        back['v'],
        v,
        `after a store round trip the value is ${String(back['v'])}`,
      );
    });
  }
});

// NaN and the infinities are the one class of value a float parser accepts and
// JSON cannot represent. parseValue keeps them as strings, so `--set n=NaN`
// stores the text the user typed instead of a value that fails on the way out.
test('parseValue keeps non-finite numbers as text', () => {
  for (const raw of ['NaN', 'nan', 'Inf', '+Inf', '-inf', 'infinity', '1e400']) {
    const v = parseValue(raw);
    assert.strictEqual(v, raw, `parseValue(${raw}) must keep the text unchanged`);
    assert.strictEqual(JSON.stringify({ v }), `{"v":${JSON.stringify(raw)}}`);
  }
});
