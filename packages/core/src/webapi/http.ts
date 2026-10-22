// The pieces both front ends over `./api.ts` need and neither one owns: the
// error-to-status mapping, the error envelope, the mutex that serializes the
// handlers, and the two path matchers that replace `http.ServeMux`.
//
// In Go these were in `internal/web/web.go`, beside the listener, because
// there was one front end. There are two now — the local viewer
// `packages/cli/src/web/web.ts` serves on a port, and `packages/pwa`'s
// router answers inside a browser tab — and each had its own copy. That is
// the drift this migration exists to prevent: `app.js` is the same script in
// both, and it reads `payload.error.message` and switches on a status code,
// so a front end that answered 409 where the other answered 400 would break
// one of the two silently and only for some failures.
//
// What is *not* here is everything that touches a transport. `web.ts` writes
// a `ServerResponse`, checks a per-process write token and reads a body off a
// socket; the PWA's router returns a `Response` and has no token, because
// there is no port and a script running in the page has already lost. Those
// stay with their front end. This module is the agreement between them.
//
// Nothing here may import `node:*` — the PWA loads it in a browser, and
// `../browser-safe.test.ts` enforces that over every source in this package.

import {
  isAmbiguous,
  isBadParent,
  isCycle,
  isNotEmpty,
  isNotFound,
  isNotInitialized,
} from '../store/store.ts';
import { isSchemaMismatch } from '../store/version.ts';
import { isInvalid } from '../taskops/edit.ts';

import { isUsage } from './api.ts';

/**
 * statusOf maps the errors the shared layer returns onto status codes, the
 * way `../exit.ts` maps them onto exit codes. The two lists are the same
 * failure classes, named for the two kinds of caller.
 *
 * It has to stay one function: `app.js` is written against these codes, and
 * two front ends serving different ones for the same failure is exactly the
 * disagreement this module exists to rule out.
 */
export function statusOf(err: unknown): [number, string] {
  if (isNotFound(err)) {
    return [404, 'not_found'];
  }
  if (isAmbiguous(err)) {
    return [409, 'ambiguous'];
  }
  if (isBadParent(err) || isCycle(err) || isNotEmpty(err) || isInvalid(err) || isUsage(err)) {
    return [400, 'usage'];
  }
  if (isNotInitialized(err) || isSchemaMismatch(err)) {
    return [503, 'config'];
  }
  return [500, 'error'];
}

/**
 * ErrorEnvelope is the shape an API failure answers with. It mirrors the
 * error envelope of `--json`, so the CLI, the local viewer and the PWA are
 * all read the same way — `app.js` reads `payload.error.message` and nothing
 * else.
 */
export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * errorEnvelope builds that shape. It is a function rather than an object
 * literal written out twice because the two front ends serialize it in two
 * places, and a key renamed in one of them would be a change `app.js` cannot
 * see coming.
 */
export function errorEnvelope(code: string, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

/**
 * messageOf is how a thrown value becomes the `message` of that envelope.
 * Both front ends did this inline and identically; a non-`Error` reaching
 * here at all is a bug somewhere below, and stringifying it beats answering
 * with `undefined`.
 */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Mutex serializes the request handlers, which is what Go got from a
 * `sync.Mutex` held for the length of a handler goroutine.
 *
 * It is a FIFO chain of promises: each caller waits on the tail, installs its
 * own release as the new tail, and the next caller cannot proceed until that
 * release is called. Nothing here is reentrant and nothing here times out —
 * both would be ways for two store calls to overlap, which is the one thing
 * the store is documented not to allow.
 *
 * Both front ends need it, and for the same reason rather than two: a
 * `node:http` handler interleaves at every `await`, and a browser fires
 * overlapping requests as fast as a key repeats.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** lock waits its turn and returns the function that gives the turn up. */
  async lock(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ahead = this.tail;
    this.tail = ahead.then(() => held);
    await ahead;
    return release;
  }
}

/**
 * PathMatch returns the path parameters a route captured, or undefined when
 * the path is not that route's. It replaces `http.ServeMux`'s patterns, which
 * went with the mux: both front ends match a table in order, and a path that
 * matches with the wrong method answers 405 the way the mux did.
 */
export type PathMatch = (pathname: string) => Record<string, string> | undefined;

/** exact matches one literal path. */
export function exact(want: string): PathMatch {
  return (pathname) => (pathname === want ? {} : undefined);
}

/**
 * perspectivePath matches `/api/perspectives/{name}`, capturing the name with
 * its percent-encoding undone.
 *
 * A perspective is named by whoever saved it, so the name may hold a space,
 * a `#` or a `/`; the caller encodes it and this decodes it. An encoded
 * slash stays inside one path segment, which is why the decode happens after
 * the split and not before. A name that is not valid percent-encoding is not
 * this route's path at all rather than a 400, because a 404 is the honest
 * answer to a URL no caller of ours would ever have written.
 */
export function perspectivePath(): PathMatch {
  return (pathname) => {
    const parts = pathname.split('/');
    // '', 'api', 'perspectives', name
    if (parts.length !== 4 || parts[1] !== 'api' || parts[2] !== 'perspectives') {
      return undefined;
    }
    const raw = parts[3] ?? '';
    if (raw === '') {
      return undefined;
    }
    try {
      return { name: decodeURIComponent(raw) };
    } catch {
      return undefined;
    }
  };
}

/**
 * taskPath matches `/api/tasks/{id}` and `/api/tasks/{id}/<tail>`, capturing
 * the id. It does not validate the id: an id the store does not know and an
 * id that is not an id are different answers, and the handler gives both.
 */
export function taskPath(tail: string): PathMatch {
  return (pathname) => {
    const parts = pathname.split('/');
    // '', 'api', 'tasks', id, …tail
    if (parts.length !== (tail === '' ? 4 : 5) || parts[1] !== 'api' || parts[2] !== 'tasks') {
      return undefined;
    }
    const taskID = parts[3] ?? '';
    if (taskID === '' || (tail !== '' && parts[4] !== tail)) {
      return undefined;
    }
    return { id: taskID };
  };
}

/**
 * Settings is what `GET /api/settings` answers, in both front ends. The page's
 * server dialog is one piece of code; what differs is whether the front end
 * lets it change anything. `tdo serve` does not — its connection is the CLI's
 * configuration, and the notice says which commands change it — while the PWA
 * owns its own and saves it in the browser.
 *
 * The token is never in here, in either direction: `token_set` says whether
 * one exists, and that is all a page is ever told.
 */
export interface Settings {
  /** editable is whether the dialog may send a `PUT` at all. */
  editable: boolean;
  /** url is the database, credential-free: `Store.describe` or the stored URL. */
  url: string;
  token_set: boolean;
  /** remember is whether the token outlives the tab, for the checkbox. */
  remember: boolean;
  /** notice is shown above the form; empty for none. */
  notice: string;
}
