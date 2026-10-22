// The router: what `packages/cli/src/web/web.ts` is, with the socket taken
// out.
//
// `tdo serve` has a listener, so its router matches a path off an
// `IncomingMessage`, checks a per-process write token and writes a
// `ServerResponse`. None of that exists here. The page and the store are in
// one JavaScript context, so a request never leaves the tab: `shim.ts` hands
// this module a method, a path and a body, and gets a `Response` back.
//
// Three things from `web.ts` are kept, and one is deliberately dropped.
//
// Kept: the route table, in the same order with the same matchers, so the
// two front ends answer the same URLs; `statusOf`, so a failure class maps
// onto the same status code the local viewer returns and `app.js` reads the
// same error envelope; and the mutex, because `Store` is documented as safe
// for one caller at a time and a browser fires overlapping requests as fast
// as a key repeats.
//
// All three are *imported* rather than kept as a copy. They were adapted
// here once, and a second copy of the error-to-status mapping is the drift
// this migration was done to prevent, so they moved into
// `@todocloud/core/webapi/http` — which both front ends already depend on
// and which imports no `node:*`. The endpoints are
// `@todocloud/core/webapi`, likewise one copy.
//
// Dropped: the write token. It exists in `tdo serve` because another origin's
// script can reach a loopback port, and the token is what it cannot guess.
// Here there is no port and no listener: the only way to reach this router is
// to be running in the page, and a script running in the page has already
// lost — it can read the credential out of storage directly. A token would be
// a lock on the inside of an open door, and pretending otherwise is worse
// than saying so.

import type { Store } from '@todocloud/core/store';

import { API, type Handler, type Req, maxBodyBytes } from '@todocloud/core/webapi';
import {
  Mutex,
  type PathMatch,
  errorEnvelope,
  exact,
  messageOf,
  statusOf,
  perspectivePath,
  tagPath,
  taskPath,
} from '@todocloud/core/webapi/http';

// Re-exported because this module is what `shim.ts`, `main.ts` and the tests
// are written against, and these were its own names before the one
// implementation of each moved into `core`.
export { maxBodyBytes } from '@todocloud/core/webapi';
export { Mutex, statusOf } from '@todocloud/core/webapi/http';

/**
 * route is one entry of the table, as in `web.ts`. The matcher is the shared
 * `PathMatch`; what differs between the two front ends is only what sits on
 * the other side of it — a `Handler` here, a socket-writing `serve` there.
 */
interface route {
  readonly method: string;
  /** match returns the path parameters, or undefined when the path is not this one. */
  readonly match: PathMatch;
  readonly handler: Handler;
}

/**
 * Router answers the API requests of one store. It is built once, when the
 * credential opens a store, and thrown away when the user disconnects.
 */
export class Router {
  readonly st: Store;
  readonly mu = new Mutex();
  /** now is the clock, injectable so a test can pin availability. */
  now: () => Date = () => new Date();
  private readonly api: API;
  private readonly routes: route[];

  constructor(st: Store) {
    this.st = st;
    this.api = new API(st, () => this.now());
    this.routes = [
      { method: 'GET', match: exact('/api/state'), handler: this.api.handleState },
      { method: 'POST', match: exact('/api/tasks'), handler: this.api.handleCreate },
      { method: 'PATCH', match: taskPath(''), handler: this.api.handleEdit },
      { method: 'DELETE', match: taskPath(''), handler: this.api.handleRemove },
      { method: 'POST', match: taskPath('done'), handler: this.api.handleDone },
      { method: 'POST', match: taskPath('status'), handler: this.api.handleStatus },
      { method: 'POST', match: taskPath('flag'), handler: this.api.handleFlag },
      { method: 'POST', match: taskPath('date'), handler: this.api.handleDate },
      { method: 'POST', match: taskPath('move'), handler: this.api.handleMove },
      { method: 'POST', match: taskPath('reorder'), handler: this.api.handleReorder },
      // The same three the local viewer serves. The store runs the saved
      // filter here too — in this front end that is Turso answering over
      // `fetch` rather than SQLite, which is exactly why the page must not
      // try to evaluate it itself.
      { method: 'PATCH', match: tagPath(), handler: this.api.handleRenameTag },
      { method: 'GET', match: perspectivePath(), handler: this.api.handleRunPerspective },
      { method: 'POST', match: exact('/api/perspectives'), handler: this.api.handleSavePerspective },
      { method: 'DELETE', match: perspectivePath(), handler: this.api.handleRemovePerspective },
    ];
  }

  /**
   * handle answers one request. The signature is deliberately the one `fetch`
   * has, so `shim.ts` is a redirection and not a translation layer, and so a
   * test can drive this module with nothing but a URL and an init.
   */
  handle = async (method: string, pathname: string, body: string | undefined): Promise<Response> => {
    let wrongMethod = false;
    for (const r of this.routes) {
      const params = r.match(pathname);
      if (params === undefined) {
        continue;
      }
      if (r.method !== method) {
        wrongMethod = true;
        continue;
      }
      // The body is truncated rather than refused, which is what the
      // listener's `io.LimitReader`-shaped read did: a body over the cap is
      // cut, and the cut JSON fails to parse as a usage error.
      const text = (body ?? '').slice(0, maxBodyBytes);
      const req: Req = {
        params,
        // A request with no body at all declares no length; `optionalBody`
        // turns on the difference, which is how `app.js` completes an item
        // with no payload.
        contentLength: body === undefined ? 0 : text.length,
        body: text,
      };
      const release = await this.mu.lock();
      try {
        return respond(await r.handler(req));
      } catch (err) {
        return fail(err);
      } finally {
        release();
      }
    }
    if (wrongMethod) {
      return httpError(405, 'usage', `${method} is not allowed here`);
    }
    return httpError(404, 'not_found', 'no such endpoint');
  };
}

function respond(payload: unknown): Response {
  return jsonResponse(200, JSON.stringify(payload));
}

/** fail maps a thrown error onto a status code and the error envelope. */
export function fail(err: unknown): Response {
  const [status, code] = statusOf(err);
  return httpError(status, code, messageOf(err));
}

/**
 * httpError puts the envelope `errorEnvelope` describes into this front end's
 * `Response`. The shape is shared with `--json` and with `tdo serve`, so all
 * three are read the same way — `app.js` reads `payload.error.message` and
 * nothing else.
 */
export function httpError(status: number, code: string, message: string): Response {
  return jsonResponse(status, JSON.stringify(errorEnvelope(code, message)));
}

/**
 * jsonResponse builds the one kind of response this module returns.
 *
 * `Cache-Control: no-store` is set even though nothing can cache these: the
 * response never reaches the network stack, and `sw.js` responds to nothing
 * but the shell. It is set anyway because the header is the statement — a
 * reply carrying someone's task list is not storable — and because a future
 * change that does put these on a wire would otherwise ship without it.
 */
function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
