// `tdo project` and `tdo folder`, ported from the project half of
// structure_refs_test.go. The reorder half of that file belongs to `tdo mv`,
// which lives in mark.go and is another agent's to port.
//
// The three ways these commands used to do the wrong thing quietly: a
// reference that resolved to the wrong kind, a flag that was accepted and
// ignored, and a --folder that exited 0 and did nothing.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';

import { showCommand } from './show.ts';
import { parseStatuses } from './list.ts';
import {
  folderCommand,
  parseReviewInterval,
  projectCommand,
  resolvedName,
} from './structure.ts';
import { reviewCommand } from './repeat.ts';
import { newHarness, type Harness } from './testsupport.ts';

/** The three commands these tests drive. */
function harness(t: TestContext): Promise<Harness> {
  return newHarness(t, [projectCommand, folderCommand, showCommand]);
}

// The numbers are the last listing's, so the same `1` means different things
// at different moments (§3.7). `tdo folder ls` followed by
// `tdo project 1 --sequential` used to make a *folder* sequential and exit 0.
test('project reshape refuses a folder', async (t: TestContext) => {
  const h = await harness(t);
  const home = h.taskOf(await h.mustRun('folder', 'add', 'Home', '--json'));
  await h.mustRun('project', 'add', 'Kitchen', '--folder', 'Home');

  await h.mustRun('folder', 'ls');
  const res = await h.run('project', '1', '--sequential');
  assert.equal(res.code, exit.Usage, `a folder is not a project: ${res.stderr}`);
  assert.match(res.stderr, /is a folder, not a project/);
  const folder = h.taskOf(await h.mustRun('show', String(home['id']), '--json'));
  assert.equal(folder['sequential'], false, 'the folder must be untouched');
});

// A change that goes through says which item it landed on, because a number
// is read off whichever listing came last.
test('project reshape names what it resolved', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('project', 'add', 'Kitchen');

  await h.mustRun('project', 'ls');
  const res = await h.mustRun('project', '1', '--sequential', '--json');
  assert.match(res.stderr, /project "Kitchen"/);
  // Machine output stays machine output: the notice is on stderr only.
  assert.equal(h.taskOf(res)['sequential'], true);
});

// `tdo project <ref> --folder F` used to exit 0 and do nothing.
test('project --folder moves an existing project', async (t: TestContext) => {
  const h = await harness(t);
  const home = h.taskOf(await h.mustRun('folder', 'add', 'Home', '--json'));
  const work = h.taskOf(await h.mustRun('folder', 'add', 'Work', '--json'));
  const project = h.taskOf(
    await h.mustRun('project', 'add', 'Kitchen', '--folder', 'Home', '--json'),
  );
  assert.equal(project['parent_id'], home['id'], 'project add --folder must file it');
  const ref = String(project['id']);

  const moved = h.taskOf(await h.mustRun('project', ref, '--folder', 'Work', '--json'));
  assert.equal(moved['parent_id'], work['id'], 'project <ref> --folder must move it');
  // An empty --folder is the top level.
  const out = h.taskOf(await h.mustRun('project', ref, '--folder', '', '--json'));
  assert.equal(out['parent_id'], null, 'an empty --folder means the top level');
  // A folder is still refused where a folder cannot go.
  const self = await h.run('project', ref, '--folder', ref);
  assert.equal(self.code, exit.Usage, `a project is not a folder: ${self.stderr}`);
});

// A flag the reshape does not apply is a usage error naming where it works,
// not an exit 0 with nothing changed.
test('project reshape refuses the flags it does not apply', async (t: TestContext) => {
  const h = await harness(t);
  const project = h.taskOf(await h.mustRun('project', 'add', 'Kitchen', '--json'));
  const ref = String(project['id']);

  for (const flag of [
    ['--note', 'later'],
    ['--tag', 'home'],
    ['--due', '2026-12-01'],
    ['--defer', '2026-12-01'],
    ['--flag'],
    ['--estimate', '25m'],
    ['--status', 'active'],
    ['--priority', '2'],
    ['--set', 'owner=ana'],
    ['--needs-review'],
  ]) {
    const res = await h.run('project', ref, ...flag);
    assert.equal(res.code, exit.Usage, `tdo project <ref> ${flag[0]}: ${res.stderr}`);
    assert.ok(
      res.stderr.includes(`does not apply ${flag[0] ?? ''}`),
      `the error must name the flag and where it works: ${res.stderr}`,
    );
  }
  // The project is as it was.
  const after = h.taskOf(await h.mustRun('show', ref, '--json'));
  assert.equal(after['note'], null);
  assert.equal(after['flagged'], false);
  assert.equal(after['due_at'], null);
});

// Every flag `tdo project` declares is either applied by the reshape or
// redirected by name. A flag listed in neither table would be silently
// ignored at that position, which is the failure this test exists to catch —
// Go's TestEveryProjectFlagIsAppliedOrRedirected.
test('every project flag is applied or redirected', async (t: TestContext) => {
  const h = await harness(t);
  const project = h.taskOf(await h.mustRun('project', 'add', 'Kitchen', '--json'));
  const ref = String(project['id']);
  // The flags the reshape itself applies; everything else must be refused
  // with a message naming where it does work.
  const applied = new Set(['folder', 'sequential', 'parallel', 'complete-with-last', 'review']);
  const cmd = projectCommand(
    { providerName: '', configPath: '' } as unknown as Parameters<typeof projectCommand>[0],
  );
  for (const [name, flag] of Object.entries(cmd.flags ?? {})) {
    if (applied.has(name) || flag.hidden === true) {
      continue;
    }
    const value = flag.type === 'string' ? ['x'] : [];
    const res = await h.run('project', ref, `--${name}`, ...value);
    assert.equal(
      res.code,
      exit.Usage,
      `--${name} is neither applied by the reshape nor redirected: exit ${res.code}\n${res.stderr}`,
    );
    assert.ok(res.stderr.includes(`--${name}`), `the refusal must name --${name}: ${res.stderr}`);
  }
});

test('project add refuses --sequential with --parallel', async (t: TestContext) => {
  const h = await harness(t);
  const res = await h.run('project', 'add', 'Kitchen', '--sequential', '--parallel');
  assert.equal(res.code, exit.Usage, res.stderr);
  assert.match(res.stderr, /opposite things/);
});

test('project add --review refuses an unreadable interval', async (t: TestContext) => {
  const h = await harness(t);
  const res = await h.run('project', 'add', 'Kitchen', '--review', 'whenever');
  assert.equal(res.code, exit.Usage, res.stderr);
  // A project that silently never came up for review would be worse than a
  // refusal.
  const empty = await h.mustRun('project', 'ls', '--json');
  assert.deepEqual(h.tasksOf(empty), []);
});

test('project ls --needs-review lists only what is due', async (t: TestContext) => {
  const h = await harness(t);
  await h.mustRun('project', 'add', 'Reviewed weekly', '--review', '1w');
  await h.mustRun('project', 'add', 'No interval at all');

  // A project with an interval that has never been reviewed is due now:
  // nobody has looked at it. This used to be the one case the listing left
  // out — `containerList` judged next_review_at at the same instant as the
  // exclusive bound, so a never-reviewed project landed exactly on the bound
  // and fell outside it, while `tdo review` listed it.
  const due = h.tasksOf(await h.mustRun('project', 'ls', '--needs-review', '--json'));
  assert.equal(due.length, 1, JSON.stringify(due));
  assert.equal(due[0]?.['title'], 'Reviewed weekly');

  // Availability is not a filter here, and a project with no interval never
  // comes up for review: the plain listing has both.
  const all = h.tasksOf(await h.mustRun('project', 'ls', '--json'));
  assert.equal(all.length, 2);
});

// The real invariant is not either listing on its own: it is that the two
// commands answer the same question. They diverged once, over exactly the
// case above, and nothing asserted the equivalence. This does, over a store
// holding every interesting review state at once.
test('project ls --needs-review and review agree on the same store', async (t: TestContext) => {
  const h = await newHarness(t, [projectCommand, folderCommand, showCommand, reviewCommand]);

  // Never reviewed, so due now.
  await h.mustRun('project', 'add', 'Never reviewed', '--review', '1w');
  // No interval, so never due.
  await h.mustRun('project', 'add', 'No interval');
  // Reviewed a fortnight ago against a weekly interval, so overdue.
  const overdue = h.taskOf(
    await h.mustRun('project', 'add', 'Overdue', '--review', '1w', '--json'),
  );
  // Reviewed just now against a yearly interval, so not due for a while.
  const fresh = h.taskOf(await h.mustRun('project', 'add', 'Fresh', '--review', '1y', '--json'));
  await h.withStore(async (st) => {
    for (const [ref, ago] of [
      [overdue, 14 * 24 * 60 * 60 * 1000],
      [fresh, 0],
    ] as const) {
      const t2 = (await st.get(String(ref['id']))).clone();
      t2.lastReviewedAt = new Date(Date.now() - ago);
      await st.update(t2);
    }
  });

  const titleOf = (tasks: ReturnType<Harness['tasksOf']>): string[] =>
    tasks.map((task) => String(task['title'])).sort();
  const listed = titleOf(h.tasksOf(await h.mustRun('project', 'ls', '--needs-review', '--json')));
  const reviewed = titleOf(h.tasksOf(await h.mustRun('review', '--json')));

  assert.deepEqual(listed, ['Never reviewed', 'Overdue']);
  // `tdo review` covers folders as well, but this store has none, so the two
  // listings are comparable item for item.
  assert.deepEqual(reviewed, listed);
});

test('folder ls and project ls are empty with a hint, not an error', async (t: TestContext) => {
  const h = await harness(t);
  for (const kind of ['folder', 'project']) {
    const res = await h.mustRun(kind, 'ls');
    assert.equal(res.stdout, '', 'an empty listing writes nothing to stdout');
    assert.match(res.stderr, new RegExp(`No ${kind}s yet`));
  }
});

test('the containers reject a verb they do not have', async (t: TestContext) => {
  const h = await harness(t);
  for (const args of [
    ['project'],
    ['folder'],
    ['folder', 'reshape'],
    ['project', 'ls', 'junk'],
    ['folder', 'ls', 'junk'],
    ['project', 'add'],
    ['folder', 'add'],
  ]) {
    const res = await h.run(...args);
    assert.equal(res.code, exit.Usage, `${args.join(' ')}: ${res.stderr}`);
    assert.notEqual(res.stderr.trim(), '', `${args.join(' ')} said nothing`);
  }
});

// A container goes at the top level or inside a folder, and the store's own
// containment check of §3.1 is what refuses the rest — as a usage error,
// because it is a mistake at the command line.
test('a folder cannot be filed inside a project', async (t: TestContext) => {
  const h = await harness(t);
  const project = h.taskOf(await h.mustRun('project', 'add', 'Kitchen', '--json'));
  const res = await h.run('folder', 'add', 'Nested', '--folder', String(project['id']));
  assert.equal(res.code, exit.Usage, res.stderr);
});

// parseStatuses lives in list.ts, which owns `tdo ls`; it is driven from
// here because the container listings share it and must accept exactly the
// same spellings.
test('parseStatuses reads one flag, a repeated one and a list', () => {
  assert.deepEqual(parseStatuses([]), []);
  assert.deepEqual(parseStatuses(['active']), ['active']);
  assert.deepEqual(parseStatuses(['active,on_hold']), ['active', 'on_hold']);
  // A repeat of one spelling is one status.
  assert.deepEqual(parseStatuses(['active', ' active ']), ['active']);
  assert.throws(() => parseStatuses(['nosuchstatus']), /--status expects/);
});

test('parseReviewInterval refuses an empty and an unreadable interval', () => {
  assert.deepEqual(parseReviewInterval('1w'), { every: '1w' });
  assert.throws(() => parseReviewInterval('  '), /must say how often/);
  assert.throws(() => parseReviewInterval('soon'));
});

test('resolvedName says the kind, the title and a short id', async (t: TestContext) => {
  const h = await newHarness(t);
  const task = await h.add('Pay the invoice');
  const rendered = resolvedName(task);
  assert.match(rendered, /^task "Pay the invoice" \(/);
  assert.ok(rendered.includes(task.id.slice(0, 8)));
  assert.ok(!rendered.includes(task.id), 'the whole id is longer than the line needs');
});
