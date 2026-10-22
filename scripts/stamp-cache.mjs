// Stamps the PWA service worker's cache name with the commit being deployed.
//
// The worker's `CACHE` name is its whole invalidation strategy: a new name
// means `install` fills a fresh cache from the allow-list and `activate`
// deletes every other one, so the launch after a deploy runs that deploy's
// shell rather than the previous one's page with this one's modules. The name
// therefore has to change with every deploy, and the one thing that is
// already different with every deploy is the commit — so the name *is* the
// commit, and there is nothing to remember and nothing to bump.
//
// This was a `sed` in the workflow, with `tdo-shell-v2` written into both its
// guard and its substitution. That made a hand-edit of the literal a failed
// deploy: the step refused a source it no longer recognised, which is exactly
// what happened. It is a script here, with a test (`stamp-cache.test.mjs`),
// because a build step that only runs on the runner is a build step nobody
// can check.
//
// Usage: node scripts/stamp-cache.mjs <sw.js> <sha>

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The line this rewrites, and the only shape it accepts. */
const line = /^const CACHE = '[^']*';$/gm;

/** A commit as the deploy knows it: 40 hex characters, or a short one. */
const sha = /^[0-9a-f]{7,40}$/;

/**
 * stamp returns the worker's source with its cache name replaced by one
 * naming this commit. It throws rather than returning the text unchanged: a
 * silent no-op here is a deploy that looks green and ships a worker that
 * never takes over, which is invisible from the outside.
 *
 * @param {string} text the worker's source
 * @param {string} commit the commit being deployed
 * @returns {string}
 */
export function stamp(text, commit) {
  if (!sha.test(commit)) {
    throw new Error(`stamp-cache: ${JSON.stringify(commit)} is not a commit sha`);
  }
  const found = text.match(line);
  if (found === null || found.length !== 1) {
    throw new Error(
      `stamp-cache: expected exactly one \`const CACHE = '…';\` line, found ${found?.length ?? 0}`,
    );
  }
  const stamped = `const CACHE = 'tdo-shell-${commit}';`;
  const out = text.replace(line, stamped);
  // The replacement happened, and it happened once. Two different facts from
  // the match above, and the one that matters is this one.
  if (!out.includes(stamped) || out.match(line)?.length !== 1) {
    throw new Error('stamp-cache: the cache name was not rewritten');
  }
  return out;
}

// Run as a command, not imported by the test beside it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, commit] = process.argv.slice(2);
  if (file === undefined || commit === undefined) {
    process.stderr.write('usage: node scripts/stamp-cache.mjs <sw.js> <sha>\n');
    process.exit(2);
  }
  try {
    const out = stamp(readFileSync(file, 'utf8'), commit);
    writeFileSync(file, out);
    process.stdout.write(`${file}: ${/^const CACHE = .*$/m.exec(out)?.[0]}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
