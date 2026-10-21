// The port of refs_adversarial_test.go.
//
// A reference is whatever an agent or a user typed, and it is resolved in a
// fixed order: a short number from the last listing, then an id prefix, then a
// usage error. These tests pin the edges of that order and the exit code each
// one produces.
//
// Go reached the resolver through `tdo add`, `tdo ls`, `tdo done`, `tdo rm`
// and `tdo import`. Of those only `show` is ported here, so the rows and the
// cached listing are made directly — which is what those commands do — and
// the multi-reference cases call resolveRefs itself.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import type { Store } from '@todocloud/core/store';
import { newTask, type Task } from '@todocloud/core/task';

import { App } from './app.ts';
import {
  NotFoundError,
  resolveContainer,
  resolveRef,
  resolveRefs,
  saveListing,
  shortNumber,
  shortRefDigits,
} from './refs.ts';
import * as shortref from './shortref.ts';
import { assertCleanFailure, type Harness, newHarness } from './testsupport.ts';

/** installListing caches ids as the last listing, as `tdo ls` does. */
async function installListing(h: Harness, ids: readonly string[]): Promise<void> {
  await h.withStore(async (st) => {
    shortref.Save(st.describe(), ids);
    return Promise.resolve();
  });
}

/** store runs fn against the harness store, for a test's own setup. */
function store<T>(h: Harness, fn: (st: Store) => Promise<T>): Promise<T> {
  return h.withStore(fn);
}

// TestResolveRefRejectsReferencesThatCannotBeOne covers the references that
// are neither a number nor a possible id prefix, which are the user's mistake
// at the command line: exit 2.
test('a reference that cannot be one is a usage error', async (t: TestContext) => {
  const h = await newHarness(t);
  await h.add('a task');

  const refs: Record<string, string> = {
    empty: '',
    whitespace: '   ',
    negative: '-1',
    'nul byte': '01J3\u0000',
    'excluded letter i': '01J3I',
    'excluded letter l': '01J3L',
    'excluded letter o': '01J3O',
    'excluded letter u': '01J3U',
    'too long for an id': '0'.repeat(27),
    punctuation: '01J3-ABC',
    path: '../../etc/passwd',
  };
  for (const [name, ref] of Object.entries(refs)) {
    // The separator is what lets a dash-leading reference reach the resolver
    // at all; without it `-1` is an unknown flag, which is also exit 2.
    const got = await h.run('show', '--', ref);
    assert.equal(
      got.code,
      exit.Usage,
      `tdo show ${JSON.stringify(ref)} (${name}): exit ${got.code}\nstderr: ${got.stderr}`,
    );
    assertCleanFailure(t, got.stderr);
  }
  // And a dash-leading reference without the separator is refused too.
  assert.equal((await h.run('show', '-1')).code, exit.Usage);
});

// A reference that could be one but matches nothing is a not-found, exit 5 —
// not a usage error, because there is nothing wrong with how it was typed.
test('a reference that matches nothing is a not-found', async (t: TestContext) => {
  const h = await newHarness(t);
  await h.add('a task');
  // No listing has been cached, so a number resolves to no id at all.

  const refs: Record<string, string> = {
    zero: '0',
    'one past the listing': '999999',
    'seven digits is a prefix': '0000000',
    '26 characters that are not a ULID': 'Z'.repeat(26),
    'a prefix nothing starts with': 'ZZZZ',
  };
  for (const [name, ref] of Object.entries(refs)) {
    const got = await h.run('show', ref);
    assert.equal(
      got.code,
      exit.NotFound,
      `tdo show ${JSON.stringify(ref)} (${name}): exit ${got.code}\nstderr: ${got.stderr}`,
    );
    assertCleanFailure(t, got.stderr);
  }
});

// Base32 is case-insensitive, so a pasted lower-cased id resolves.
test('a lower-cased id resolves', async (t: TestContext) => {
  const h = await newHarness(t);
  const added = await h.add('a task');

  const shown = h.taskOf(await h.mustRun('show', added.id.toLowerCase(), '--json'));
  assert.equal(shown['id'], added.id);
});

// Two tasks sharing a prefix is exit 6, and the message must not name one of
// them as though it had been chosen.
test('an ambiguous prefix is reported as such', async (t: TestContext) => {
  const h = await newHarness(t);
  // Two literal ids, made to share a prefix deliberately.
  await h.add('one', '01J3ABCDEFGHJKMNPQRSTVWXYZ');
  await h.add('two', '01J3ABCDEFGHJKMNPQRSTVWXY0');

  const got = await h.run('show', '01J3ABCDEFGHJKMNPQRSTVWXY');
  assert.equal(got.code, exit.Ambiguous, got.stderr);
  assertCleanFailure(t, got.stderr);
  assert.doesNotMatch(got.stderr, /\bone\b|\btwo\b/, 'the message names a task as though it had been chosen');

  // The full id of either task disambiguates.
  const shown = h.taskOf(await h.mustRun('show', '01J3ABCDEFGHJKMNPQRSTVWXY0', '--json'));
  assert.equal(shown['title'], 'two');
});

// A tombstone is still addressable: `rm` is reversible only because the task
// is still there to be found by its prefix.
test('a tombstoned task still resolves, and a purged one does not', async (t: TestContext) => {
  const h = await newHarness(t);
  const added = await h.add('to be removed');
  await store(h, async (st) => {
    const t2 = await st.get(added.id);
    t2.deletedAt = new Date();
    return st.update(t2);
  });

  const shown = h.taskOf(await h.mustRun('show', added.id.slice(0, 8), '--json'));
  assert.equal(shown['id'], added.id);
  assert.notEqual(shown['deleted_at'], undefined, 'the task resolved but is not tombstoned');

  // Once purged it is gone, and the same prefix is a not-found.
  await store(h, async (st) => st.purge(added.id));
  assert.equal((await h.run('show', added.id.slice(0, 8))).code, exit.NotFound);
});

// A reference that is both a valid short number and a valid id prefix is read
// as the number: that is the documented order in refs.ts, and it is what the
// user just read off the screen. Every ULID this decade starts with "01J", so
// "01" is exactly that collision.
test('the number is preferred over an id prefix', async (t: TestContext) => {
  const h = await newHarness(t);
  const first = await h.add('first', '01J3AAAAAAAAAAAAAAAAAAAAAA');
  const second = await h.add('second', '01J3BBBBBBBBBBBBBBBBBBBBBB');
  await installListing(h, [first.id, second.id]);

  // "01" is a number (1) and also the prefix both ids share, which would be
  // ambiguous if it were read as a prefix.
  const shown = h.taskOf(await h.mustRun('show', '01', '--json'));
  assert.equal(shown['id'], first.id, 'show 01 did not resolve to the first row of the listing');

  // Seven digits is past the short-number limit, so the same shape is read as
  // a prefix again — here one that matches nothing.
  assert.equal((await h.run('show', '0000001')).code, exit.NotFound);
});

// The boundary itself, which the test above approaches from both sides.
test('a short number is at most six digits', () => {
  assert.equal(shortRefDigits, 6);
  assert.equal(shortNumber('1'), 1);
  assert.equal(shortNumber('999999'), 999999);
  assert.equal(shortNumber('0000000'), undefined);
  assert.equal(shortNumber(''), undefined);
  assert.equal(shortNumber('-1'), undefined);
  assert.equal(shortNumber('1 '), undefined);
  assert.equal(shortNumber('1e3'), undefined);
  assert.equal(shortNumber('٣'), undefined, 'an Arabic-Indic digit is not a short number');
});

// The same task named twice in one command is applied once, whether it is
// spelled the same way both times or as a number and a prefix.
test('a repeated reference resolves once', async (t: TestContext) => {
  const h = await newHarness(t);
  const added = await h.add('a task');
  await installListing(h, [added.id]);
  const a = new App({ getenv: (name) => h.env[name] ?? '' });

  await store(h, async (st) => {
    const twice = await resolveRefs(a, st, [added.id, added.id]);
    assert.equal(twice.length, 1, 'the repeated reference resolved twice');

    const mixed = await resolveRefs(a, st, ['1', added.id.slice(0, 6)]);
    assert.equal(mixed.length, 1, 'a number and a prefix for one task resolved twice');
    assert.equal(mixed[0]?.id, added.id);
  });
});

// A command that resolves several references resolves all of them before it
// changes anything, so one bad reference leaves the others untouched.
test('resolveRefs is all or nothing', async (t: TestContext) => {
  const h = await newHarness(t);
  const added = await h.add('a task');
  const a = new App({ getenv: (name) => h.env[name] ?? '' });

  await store(h, async (st) => {
    await assert.rejects(
      () => resolveRefs(a, st, [added.id, 'ZZZZ']),
      (err: unknown) => exit.classify(err).code === exit.NotFound,
    );
  });
  // Nothing was applied, because nothing had been resolved yet.
  const shown = h.taskOf(await h.mustRun('show', added.id, '--json'));
  assert.equal(shown['done'], false);
});

test('no reference at all is a usage error', async (t: TestContext) => {
  const h = await newHarness(t);
  const a = new App({ getenv: (name) => h.env[name] ?? '' });
  await store(h, async (st) => {
    await assert.rejects(
      () => resolveRefs(a, st, []),
      (err: unknown) => exit.classify(err).code === exit.Usage,
    );
  });
});

// notFoundf carries its own wording and still classifies as a not-found, so
// the user reads one sentence rather than a wrapped chain.
test('a not-found error keeps its own message', () => {
  const err = new NotFoundError('no task numbered 3 in the last listing');
  assert.equal(exit.classify(err).code, exit.NotFound);
  assert.equal(exit.classify(err).jsonCode, exit.CodeNotFound);
  assert.equal(err.message, 'no task numbered 3 in the last listing');
});

// Machine output does not renumber the listing: letting a backgrounded
// `tdo ls --json` renumber it under whoever is reading the terminal would make
// `tdo done 2` mean a different task.
test('saveListing leaves the cache alone for --json and for an empty listing', async (t: TestContext) => {
  const h = await newHarness(t);
  const kept = await h.add('kept');
  await installListing(h, [kept.id]);
  const a = new App({ getenv: (name) => h.env[name] ?? '' });

  await store(h, async (st) => {
    const other: Task = newTask('01J3CCCCCCCCCCCCCCCCCCCCCC', 'task', 'other', new Date());

    a.out.json = true;
    saveListing(a, st, [other]);
    assert.equal(shortref.Lookup(st.describe(), 1), kept.id, '--json renumbered the listing');

    a.out.json = false;
    saveListing(a, st, []);
    assert.equal(shortref.Lookup(st.describe(), 1), kept.id, 'an empty listing discarded the numbers');

    saveListing(a, st, [other]);
    assert.equal(shortref.Lookup(st.describe(), 1), other.id, 'a human listing did not renumber');
    return Promise.resolve();
  });
});

// resolveContainer accepts a title as well as a number or a prefix, because a
// container is typed far more often than an action.
test('a container resolves by title, and the kinds are enforced', async (t: TestContext) => {
  const h = await newHarness(t);
  const a = new App({ getenv: (name) => h.env[name] ?? '' });

  const project = newTask('01J3PPPPPPPPPPPPPPPPPPPPPP', 'project', 'Invoices', new Date());
  const action = newTask('01J3TTTTTTTTTTTTTTTTTTTTTT', 'task', 'pay it', new Date());
  await store(h, async (st) => {
    await st.add(project);
    await st.add(action);
  });

  await store(h, async (st) => {
    // By title, and case-insensitively.
    assert.equal((await resolveContainer(a, st, 'invoices', 'project')).id, project.id);
    // By id prefix.
    assert.equal((await resolveContainer(a, st, '01J3PPPP', 'project')).id, project.id);
    // A reference that resolves to the wrong kind is the user's mistake.
    await assert.rejects(
      () => resolveContainer(a, st, '01J3TTTT', 'project'),
      (err: unknown) => exit.classify(err).code === exit.Usage,
    );
    // An empty reference likewise.
    await assert.rejects(
      () => resolveContainer(a, st, '  ', 'project', 'folder'),
      (err: unknown) => exit.classify(err).code === exit.Usage,
    );
    // A title nothing answers to is a not-found.
    await assert.rejects(
      () => resolveContainer(a, st, 'Nothing', 'project'),
      (err: unknown) => exit.classify(err).code === exit.NotFound,
    );
  });
});

test('two containers with one title are ambiguous', async (t: TestContext) => {
  const h = await newHarness(t);
  const a = new App({ getenv: (name) => h.env[name] ?? '' });
  await store(h, async (st) => {
    await st.add(newTask('01J3QQQQQQQQQQQQQQQQQQQQQQ', 'project', 'Invoices', new Date()));
    await st.add(newTask('01J3RRRRRRRRRRRRRRRRRRRRRR', 'project', 'invoices', new Date()));
  });
  await store(h, async (st) => {
    await assert.rejects(
      () => resolveContainer(a, st, 'Invoices', 'project'),
      (err: unknown) => exit.classify(err).code === exit.Ambiguous,
    );
  });
});

// A number comes from a listing the user just read, so a miss is a miss: it
// never falls through to a title, even when a container is called "1".
test('a numbered container reference never falls through to a title', async (t: TestContext) => {
  const h = await newHarness(t);
  const a = new App({ getenv: (name) => h.env[name] ?? '' });
  await store(h, async (st) => st.add(newTask('01J3SSSSSSSSSSSSSSSSSSSSSS', 'project', '1', new Date())));

  await store(h, async (st) => {
    await assert.rejects(
      () => resolveContainer(a, st, '1', 'project'),
      (err: unknown) => exit.classify(err).code === exit.NotFound,
    );
  });
});

// The resolver answers from the store the reference was typed against: a
// number that means one thing on one provider must never resolve to something
// else on another.
test('a listing from another store is not consulted', async (t: TestContext) => {
  const h = await newHarness(t);
  const added = await h.add('a task');
  await store(h, async (st) => {
    shortref.Save('turso example.turso.io', [added.id]);
    return Promise.resolve();
  });
  assert.equal((await h.run('show', '1')).code, exit.NotFound);
});

// A damaged cache must degrade to a plain not-found rather than taking the
// process down. shortref.test.ts covers the reader on hostile input; this is
// the same thing where a user meets it, through a command resolving a number
// against a cache that is no longer JSON.
test('a corrupt short-reference cache is not fatal', async (t: TestContext) => {
  const h = await newHarness(t);
  await h.mustRun('add', 'Cached');
  await h.mustRun('ls');

  fs.writeFileSync(path.join(h.env['TODOCLOUD_STATE_DIR'] ?? '', 'lastlist.json'), '{not json', {
    mode: 0o600,
  });
  const res = await h.run('done', '1');
  assert.equal(res.code, exit.NotFound, `exit ${res.code}: ${res.stderr}`);

  // The id prefix path still works.
  const tasks = h.tasksOf(await h.mustRun('ls', '--json'));
  await h.mustRun('done', String(tasks[0]?.['id']).slice(0, 8));
});
