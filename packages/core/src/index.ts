// The runtime-agnostic core: exit codes, ids, secrets and the task model, and
// the rest of the packages as they are ported.
export * from './exit.ts';
export * from './id.ts';
export * from './providercli.ts';
export * from './recur.ts';
export * from './secret.ts';
export * from './task.ts';
// The store interface and its pure logic. `store/schema.ts` and
// `store/historical.ts` stay out of the barrel on purpose: they were a
// separate Go package and export bare names (`initial`, `steps`, `validate`)
// that would mislead at the top level. Providers import them by path.
export * from './store/store.ts';
export * from './store/event.ts';
export * from './store/availability.ts';
export * from './store/completion.ts';
export * from './store/filter.ts';
export * from './store/version.ts';

// `output/*` stays out of the barrel, like `store/schema.ts`: `Row`, `Rows`
// and `Table` are generic enough to collide, and `sanitize`/`fieldText` are
// exported only so the tests can reach them. Callers import by path.
// `taskops/*` stays out too, and for a harder reason than the others: it
// exports `complete` and `apply`, which `recur.ts` and `store/store.ts`
// already export. Callers import by path.
// `webapi/*` stays out for the first reason and the second at once. `Req`,
// `Handler`, `Mutex` and `exact` are names a front end is likely to want for
// something of its own, `isUsage` is one letter from `usagef` in `exit.ts`,
// and `statusOf` reads like a task's status rather than an HTTP code at the
// top level. It is also the one part of this package that only the two
// browser front ends use, so putting it in the barrel would pull the whole
// API layer into every `import ... from '@todocloud/core'` in the CLI. The
// two front ends import `@todocloud/core/webapi` and
// `@todocloud/core/webapi/http` by path.
