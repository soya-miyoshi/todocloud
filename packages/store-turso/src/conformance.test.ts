// The shared conformance suite, run against the fake pipeline server, which
// executes the statements this provider sends on a real engine. It is the
// acceptance test for the port: the tree rules of PLAN.md §3.1 and the
// availability computation of §3.3 are the shared ones, and this is what
// proves that sending them over the wire did not change any of their answers.

import { run } from '@todocloud/store-testkit';

import { newFakeServer } from './fakeserver.test.ts';
import { open } from './turso.ts';

// A fresh fake server per sub-suite, so no sub-suite can see another's rows.
// The store is handed over un-initialized on purpose: the suite calls init
// itself, because "init on an empty store works and is idempotent" is one of
// the rules it checks.
run(async (t) => {
  const fake = await newFakeServer(t);
  const store = open(fake.config());
  t.after(() => store.close());
  return store;
});
