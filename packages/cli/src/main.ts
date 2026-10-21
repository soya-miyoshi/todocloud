#!/usr/bin/env -S node --experimental-strip-types
// tdo keeps a todo list in a database the user owns.
//
// This file is deliberately tiny: everything the CLI does lives in app.ts,
// which is also what the tests drive, so that nothing is only reachable
// through the real process.

import * as os from 'node:os';
import * as path from 'node:path';

/**
 * enableCompileCache turns on V8's on-disk bytecode cache, on the runtimes
 * that have it.
 *
 * It is resolved through a dynamic import rather than
 * `import { enableCompileCache } from 'node:module'`, because a named import
 * of a missing export is a load-time error, not a missing value: Deno's
 * `node:module` has no such export and refuses the whole module with "does
 * not provide an export named 'enableCompileCache'", so one startup
 * optimisation would stop `tdo` from running at all. Bun has its own
 * transpiler cache and does not provide this either. Both should simply skip
 * it, which is what a defensive resolve buys.
 *
 * Why it is worth any of this, on Node: the agent usage in PLAN.md §8 spends
 * one process per command, so startup is paid on every invocation. Measured
 * on an M-series Mac, `tdo --help` over twenty runs: 151 ms without this,
 * 84 ms with it, against a 42 ms floor for `node -e 0`. Nearly all of the
 * saving is V8 not recompiling the same 66 modules every time. The win is
 * Node-only; nothing else here depends on which runtime is in use.
 *
 * It is called here rather than left to the user to set NODE_COMPILE_CACHE,
 * because a default nobody knows about is not a default. If the user has set
 * that variable, Node honours it and this call is a no-op.
 *
 * The cache is bytecode keyed by file content, so a stale entry cannot be
 * wrong — it is either used or discarded. A failure is ignored on purpose:
 * a read-only or full disk should cost the startup saving, not the command.
 * Nothing here is a credential, and nothing here is task data.
 */
async function enableCompileCacheIfAvailable(): Promise<void> {
  try {
    const mod: unknown = await import('node:module');
    const enable = (mod as { enableCompileCache?: (dir?: string) => unknown })
      .enableCompileCache;
    if (typeof enable !== 'function') {
      return;
    }
    const configured = process.env['XDG_CACHE_HOME'];
    const base =
      configured !== undefined && configured !== ''
        ? configured
        : path.join(os.homedir(), '.cache');
    enable(path.join(base, 'todocloud', 'compile'));
  } catch {
    // Startup is slower; the command still runs. A runtime without
    // `node:module` at all lands here too.
  }
}

/**
 * main is the whole process body.
 *
 * It exists because there must be no top-level `await` in this file:
 * `bun build --compile --bytecode` needs CommonJS output to precompile
 * bytecode and refuses a top-level await with "await can only be used inside
 * an async function", and that bytecode is a startup win worth keeping. Every
 * await therefore sits inside this function, and the only statement at the
 * top level is the call below.
 *
 * The global `process`, not `node:process`: the imported module types
 * exitCode as read-only, and this sets it.
 */
async function main(): Promise<number> {
  await enableCompileCacheIfAvailable();
  // Imported after the cache is enabled, so the modules it loads are the ones
  // the cache is there for, and dynamically because a static import would be
  // evaluated before any of this body runs.
  const { Run } = await import('./app.ts');
  return await Run(process.argv);
}

// Not awaited, because awaiting it here would be the top-level await this
// file has to do without. The promise Run returns rejects only if the CLI
// failed to handle its own error, which is a bug rather than a user-facing
// failure, so it is reported and charged exit code 1 the way an unhandled
// rejection would be.
void main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
