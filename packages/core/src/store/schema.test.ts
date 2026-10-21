import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Step,
  Version,
  initial,
  pending,
  steps,
  validate,
} from './schema.ts';
import { historical, historicalVersions } from './historical.ts';

// Go's test swapped the package-level `steps` variable for a ladder of its own.
// A module binding cannot be reassigned, so `validate` and `pending` take the
// ladder to read as an optional argument and the tests pass one. The shipped
// ladder is read back through `steps()`.
const shipped = steps();

// The ladder and the version are one thing in two parts, and the part that is
// easy to forget is the step. Bumping Version without appending the step that
// gets there must stop the process rather than leave a build that expects a
// schema nothing produces.
test('the ladder must reach the version it claims', () => {
  // One step too many: the ladder is the shipped one plus a rung past
  // Version, which is what bumping the ladder and forgetting the version
  // looks like.
  const tooFar: Step[] = [
    ...shipped,
    {
      to: Version + 1,
      name: 'a step past the current version',
      statements: ['SELECT 1'],
    },
  ];
  assert.notEqual(
    validate(tooFar),
    undefined,
    'a ladder that climbs past Version must be refused, because one of the two was edited and the other was not',
  );

  assert.notEqual(
    validate([
      { to: 3, name: 'a step that skips version 2', statements: ['SELECT 1'] },
    ]),
    undefined,
    'a ladder with a gap in it must be refused; a store at version 2 would have nothing to run',
  );

  assert.notEqual(
    validate([{ to: 2, name: '', statements: ['SELECT 1'] }]),
    undefined,
    'a step with no name must be refused; the name is what `tdo migrate` prints and what a failure reports',
  );

  assert.notEqual(
    validate([{ to: 2, name: 'a step with nothing in it', statements: [] }]),
    undefined,
    'a step with no statements must be refused; it would record a version it did not reach',
  );

  assert.equal(
    validate(shipped),
    undefined,
    `the shipped ladder must be consistent with Version ${Version}`,
  );
});

// pending is what both providers iterate, so it decides what a store owes.
test('pending returns only the steps a store still owes', () => {
  const ladder: Step[] = [
    { to: 2, name: 'two', statements: ['SELECT 2'] },
    { to: 3, name: 'three', statements: ['SELECT 3'] },
  ];
  for (const tc of [
    { from: 1, want: [2, 3] },
    { from: 2, want: [3] },
    { from: 3, want: [] },
    { from: 4, want: [] },
  ]) {
    assert.deepEqual(
      pending(tc.from, ladder).map((s) => s.to),
      tc.want,
      `pending(${tc.from})`,
    );
  }
});

// The DDL is handed to two providers that will each loop over it. Neither may
// be able to edit the schema for the other by accident.
test('initial and steps hand out copies', () => {
  const first = initial();
  assert.ok(first.length > 0, 'initial returned no statements');
  first[0] = 'DROP TABLE tasks';
  assert.notEqual(
    initial()[0],
    'DROP TABLE tasks',
    "initial handed out the module's own array; a provider could rewrite the schema for the other one",
  );

  const rungs = steps();
  assert.ok(rungs.length > 0, 'steps returned no rungs');
  rungs.length = 0;
  assert.ok(steps().length > 0, "steps handed out the module's own array");
});

// Every released version needs its frozen DDL, or the conformance harness has
// nothing to carry forward from and quietly checks less than it claims.
test('every released version has its historical schema', () => {
  for (let v = 1; v <= Version; v++) {
    assert.notEqual(
      historical(v),
      undefined,
      `version ${v} has no frozen DDL in historical.ts; without it nothing proves a store created by that release can still be migrated`,
    );
  }
  const got = historicalVersions();
  assert.equal(
    got.length,
    Version,
    `historicalVersions returned ${JSON.stringify(got)}, want one entry per released version up to ${Version}`,
  );
});

// The frozen DDL is handed out by copy for the same reason the live DDL is.
test('historical hands out copies', () => {
  const first = historical(1);
  assert.notEqual(first, undefined);
  (first as string[])[0] = 'DROP TABLE tasks';
  assert.notEqual((historical(1) as string[])[0], 'DROP TABLE tasks');
});
