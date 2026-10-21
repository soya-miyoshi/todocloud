// The port of internal/cli/schema_mismatch_test.go, less its administrative
// half, which landed in admin.test.ts alongside the commands it is about.
//
// A store at a schema version this binary does not write is the one failure
// that must never reach a command body. A binary that queried it anyway
// would, at best, return a raw engine error about a column that does not
// exist; at worst it would answer — a listing missing exactly the rows a
// column it has never heard of would have matched. Either is worse than
// refusing, so every command checks the version first and says which way the
// mismatch goes.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

import * as exit from '@todocloud/core/exit';
import * as schema from '@todocloud/core/store/schema';

import { type Harness, newHarness } from './testsupport.ts';

/**
 * setRecordedVersion rewrites the schema version in the harness database
 * behind the tool's back, which is how a store at the wrong version is built
 * without a second binary to build it with. It writes only the meta row, so
 * the data stays exactly what the commands under test would otherwise read.
 *
 * The version is bound as a BigInt: `node:sqlite` binds a JS number as REAL,
 * which would write "2.0" into a TEXT column where every other writer puts
 * "2" (MIGRATION.md).
 */
function setRecordedVersion(h: Harness, v: number): void {
  const db = new DatabaseSync(h.db);
  try {
    db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(BigInt(v), schema.MetaKey);
  } finally {
    db.close();
  }
}

/**
 * recordedVersion reads the marker back, so a test can assert that a command
 * which refused also left it alone.
 */
function recordedVersion(h: Harness): number {
  const db = new DatabaseSync(h.db);
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(schema.MetaKey);
    const raw = String((row as Record<string, unknown>)['value']);
    const v = Number(raw);
    assert.ok(Number.isInteger(v), `the recorded version ${raw} is not a number`);
    return v;
  } finally {
    db.close();
  }
}

/**
 * The whole surface a user reaches on an ordinary day: the reads that could
 * answer wrongly and the writes that could write wrongly. REF stands in for
 * the task written before the version was changed.
 */
const commands: readonly string[][] = [
  ['ls'],
  ['ls', '--json'],
  ['ls', '--all', '--json'],
  ['ls', '--tree'],
  ['next', '--json'],
  ['inbox', '--json'],
  ['review', '--json'],
  ['project', 'ls', '--json'],
  ['folder', 'ls', '--json'],
  ['perspective', 'ls', '--json'],
  ['export', '--all', '--json'],
  ['add', 'Written against the wrong schema', '--json'],
  ['edit', 'REF', '--title', 'Renamed', '--json'],
  ['done', 'REF', '--json'],
  ['undone', 'REF', '--json'],
  ['drop', 'REF', '--json'],
  ['flag', 'REF', '--json'],
  ['mv', 'REF', '--inbox', '--json'],
  ['repeat', 'REF', '1w', '--json'],
  ['rm', 'REF', '--json'],
  ['rm', 'REF', '--purge', '--yes', '--json'],
];

const mismatches: readonly { name: string; version: number; advice: string }[] = [
  {
    name: 'a store older than the binary is told to migrate',
    // Below Version is the state `tdo migrate` exists for.
    version: schema.Version - 1,
    advice: 'run `tdo migrate`',
  },
  {
    name: 'a store newer than the binary is told to upgrade tdo',
    // Above Version is a store some later tdo wrote. There is nothing to
    // migrate and guessing at it is how data is lost.
    version: schema.Version + 1,
    advice: 'upgrade tdo',
  },
];

for (const tc of mismatches) {
  test(`no command reads or writes a store at the wrong schema version: ${tc.name}`, async (t: TestContext) => {
    const h = await newHarness(t);
    const title = 'Written before the mismatch';
    const id = String(h.taskOf(await h.mustRun('add', title, '--json'))['id']);
    setRecordedVersion(h, tc.version);

    for (const args of commands) {
      const run = args.map((a) => (a === 'REF' ? id : a));
      const res = await h.run(...run);
      const where = `\`tdo ${run.join(' ')}\``;
      assert.equal(
        res.code,
        exit.Config,
        `${where}: exit ${res.code}, want ${exit.Config}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
      const both = res.stdout + res.stderr;
      assert.ok(
        both.includes(tc.advice),
        `${where}: the refusal does not say ${JSON.stringify(tc.advice)}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
      assert.ok(
        both.includes(`schema version ${tc.version}`),
        `${where}: the refusal does not name the version found\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
      // Nothing of the task list may leak out of a command that refused: a
      // partial answer is the wrong answer this check exists to prevent.
      assert.ok(
        !res.stdout.includes(title),
        `${where}: a refused command still printed task data: ${res.stdout}`,
      );
    }

    // The store is untouched: once the version is put back, the task is
    // exactly where it was and nothing was written to it.
    setRecordedVersion(h, schema.Version);
    const tasks = h.tasksOf(await h.mustRun('ls', '--all', '--json'));
    assert.equal(tasks.length, 1, `the refused commands changed the store: ${JSON.stringify(tasks)}`);
    assert.equal(tasks[0]?.['title'], title, `the refused commands changed the store: ${JSON.stringify(tasks)}`);
  });
}

// The administrative commands are exempt, because each of them is either the
// fix for a mismatch or incapable of reading one wrongly. `tdo migrate`'s own
// refusal is in admin.test.ts, beside the rest of that command.
test('the administrative commands still work on a mismatched store', async (t: TestContext) => {
  const h = await newHarness(t);
  setRecordedVersion(h, schema.Version + 1);

  // version and config read no store at all.
  assert.notEqual(h.decode(await h.mustRun('version', '--json'))['version'], undefined);
  assert.equal(h.decode(await h.mustRun('config', '--json'))['provider'], 'sqlite');

  // doctor reports the mismatch through its own shape, not the error
  // envelope, and says which way it goes.
  const res = await h.run('doctor', '--json');
  assert.equal(res.code, exit.Error, `doctor exit ${res.code}, want ${exit.Error}\nstdout: ${res.stdout}`);
  const report = h.decode(res);
  assert.equal(report['ok'], false, `doctor is happy with a mismatched store: ${res.stdout}`);
  assert.equal(report['from'], schema.Version + 1, res.stdout);
  assert.equal(report['to'], schema.Version, res.stdout);
  assert.match(res.stdout, /upgrade tdo/u);

  // init opens the store unchecked, because a store it is pointed at may have
  // no schema at all — but it is idempotent, so it also meets stores that
  // already have one. Against a store from the future it must refuse rather
  // than stamp this binary's version over the higher one: that would leave
  // the marker describing a schema that is not there, and every later version
  // check would pass while the two disagreed.
  const init = await h.run('init', '--json');
  assert.equal(
    init.code,
    exit.Config,
    `init against a store from the future exits ${init.code}, want ${exit.Config}\nstdout: ${init.stdout}\nstderr: ${init.stderr}`,
  );
  assert.match(init.stdout, /upgrade tdo/u);
  // And the marker is untouched, which is the part that matters.
  assert.equal(
    recordedVersion(h),
    schema.Version + 1,
    'init rewrote the recorded version; it must be left alone',
  );
});
