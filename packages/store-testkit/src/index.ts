/**
 * The provider conformance suite.
 *
 * It is the executable half of the store contract: everything PLAN.md §3 says
 * a provider must do, written as assertions a provider either passes or does
 * not. SQLite passes it, and so must every provider added later, which is the
 * only way "availability is computed in one place" stays true once there is
 * more than one place.
 *
 * A failure here names the rule that was broken, not just the values that
 * differed, because the reader is someone porting a provider who needs to know
 * which paragraph of the spec they are arguing with.
 *
 * ## How a provider calls it
 *
 * A provider's own `conformance.test.ts` is this, and nothing else:
 *
 * ```ts
 * import { run } from '@todocloud/store-testkit';
 *
 * import { SqliteStore } from './store.ts';
 *
 * run(() => new SqliteStore(':memory:'));
 * ```
 *
 * `run` takes a factory for a **fresh, empty** store and registers one
 * `node:test` test per sub-suite — eighteen of them. The factory is called
 * once per sub-suite, is handed that sub-suite's own `TestContext` (so a
 * provider that needs a temporary file can tear it down with `t.after`), may
 * be async, and must not call `init`: the suite does that itself, because
 * `init` on an empty store is one of the things being checked.
 *
 * Nothing has to be awaited. `run` registers tests; `node --test` runs them.
 *
 * The migration harness is a second entry point, because it needs raw SQL
 * access that the `Store` interface deliberately does not offer:
 *
 * ```ts
 * import { NullText, runMigrations } from '@todocloud/store-testkit';
 *
 * runMigrations({
 *   newStore: () => new SqliteStore(':memory:'),       // no schema, already open
 *   exec: async (t, s, ...stmts) => { ... },           // raw statements, in order
 *   query: async (t, s, query) => [[...]],             // rows; a NULL is NullText
 * });
 * ```
 *
 * To nest the whole thing under one test of a provider's own, pass
 * `node:test`'s `t.test` as the second argument:
 *
 * ```ts
 * test('the sqlite provider conforms', async (t) => {
 *   run(() => new SqliteStore(':memory:'), t.test.bind(t));
 * });
 * ```
 *
 * ## Why this is not a `*.test.ts` file
 *
 * These are source files. `npm test` globs every `.test.ts` under
 * `packages/*`, and a suite that matched that glob would run with no provider
 * to run against. The provider owns the test file; this package owns the
 * rules.
 *
 * ## Port notes
 *
 * Go's `storetest.Run(t, factory)` took a `*testing.T` and drove subtests from
 * it. `node:test` splits that in two — `test` registers and `TestContext`
 * asserts — so `run` takes the registrar and each case reaches its own context
 * through the fixture. `Ladder.Diff` became the free function `ladderDiff`,
 * because `Ladder` is an interface a provider fills in rather than a struct it
 * constructs. Everything else keeps Go's names, lower-cased where the
 * TypeScript port of `Store` lower-cased them.
 */

export { type Factory, type Register, run } from './storetest.ts';
export {
  type Ladder,
  ladderDiff,
  NullText,
  runLadder,
  runMigrations,
  type SQL,
  type VersionData,
} from './migrate.ts';
export { DefaultData } from './migratedata.ts';
