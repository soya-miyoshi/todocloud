// Module web is the viewer `tdo serve` puts on a local port: a read-write
// browser UI over the same store the CLI writes to.
//
// It is a front end and nothing more. Every read and every write goes through
// @todocloud/core/taskops, the layer `tdo ls` and `tdo done` go through, so
// the two cannot disagree about what "available" means or about what
// completing a repeating item does. The JSON a task is rendered as is
// TaskView, which is the shape docs/agents.md documents for `--json`, so the
// browser and an agent parse the same thing.
//
// Three things are deliberate about the way it listens.
//
// A store is documented as safe for one caller at a time, so one mutex
// serializes every request. A local viewer has one user; a queue costs
// nothing worth measuring and removes a whole class of failure.
//
// Writes require a token minted at startup and handed to the page it serves.
// Another origin's script can reach the port — a browser will connect to
// localhost from any page — but it cannot read the response without CORS
// headers, which are never sent, and it cannot guess the token, so it cannot
// write. That is what makes the editing UI safe to run on a shared machine,
// and it is why the token is a header rather than a cookie: a cookie would
// be attached to a cross-origin request automatically, which is the whole
// problem.
//
// The default bind address is loopback. --addr is how a user says they want
// it reachable from the network, and when they do, the warning says what
// they have exposed: the listener is unauthenticated beyond the token, which
// anyone who can load the page is given.
//
// Port notes, where TypeScript cannot hold the Go shape exactly:
//
//   - Go's guarantee was serialization: one `sync.Mutex` held across the
//     whole handler, and a `net/http` handler is a goroutine that runs to
//     completion. A `node:http` handler is async and interleaves at every
//     `await`, so the mutex is an explicit FIFO queue of promises
//     (`Mutex`, in `@todocloud/core/webapi/http`) and every endpoint runs
//     between its `lock` and its release. Losing that is easy and silent,
//     which is why `web.test.ts` proves two overlapping requests do not
//     interleave rather than assuming it.
//   - `go:embed` compiled the assets into the binary. There is no equivalent,
//     so they are read at startup from the directory `resolveBundled` finds
//     relative to `import.meta.dirname` — `../../assets` in a checkout, an
//     npm install and the Node single executable, and `./assets` in a Bun
//     executable, which has no directory tree to walk up. The asset
//     directory is therefore a runtime dependency of this module where Go
//     had it in the executable: a `tdo` installed without
//     `packages/cli/assets` beside it fails in `New`, not at build.
//   - `http.ServeMux`'s patterns are gone with it. `routes` is a table of
//     method, a path matcher and a handler, matched in order, and a path that
//     matches with the wrong method answers 405 the way the mux did. The
//     matchers themselves (`exact`, `taskPath`) are in
//     `@todocloud/core/webapi/http`, because the PWA's router matches the
//     same table and the two front ends answering different URLs would be
//     the same class of drift as answering different status codes.
//   - `html/template` is gone too. `index.html` holds exactly two actions,
//     `{{.Token}}` and `{{.Store}}`, and `render` substitutes them with HTML
//     escaping. An action it does not know is refused in `New`, which is
//     where a template Go could not parse also failed.
//   - Go returned `(T, error)`; a failure throws here.
//
// What is in this file is the transport and nothing else. The endpoints, the
// error-to-status mapping, the error envelope, the mutex and the path
// matchers are in `@todocloud/core/webapi` and
// `@todocloud/core/webapi/http`, shared with `packages/pwa` — see the header
// of `packages/core/src/webapi/api.ts` for why they live there.

import { createServer, type IncomingMessage, type Server as HTTPServer, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import type { Store } from '@todocloud/core/store';

import { resolveBundled } from '../respath.ts';

import { API, type Handler, type Req, maxBodyBytes } from '@todocloud/core/webapi';
import {
  Mutex,
  type PathMatch,
  errorEnvelope,
  exact,
  messageOf,
  statusOf,
  taskPath,
} from '@todocloud/core/webapi/http';

// Re-exported because they were this module's own before they moved into
// `core`, and `serve.ts` and `web.test.ts` are written against this module.
// There is one implementation of each; these are the names it already had
// here.
export { maxBodyBytes } from '@todocloud/core/webapi';
export { Mutex, statusOf } from '@todocloud/core/webapi/http';

/**
 * TokenHeader is the header a write carries its token in. It is a header and
 * not a cookie on purpose: see the note at the top of this module.
 */
export const TokenHeader = 'x-tdo-token';

/**
 * assetDir is where the hand-written page lives: `packages/cli/assets`, two
 * directories up from this one in a checkout, in an npm install and in the
 * Node single executable, and beside the entry in a Bun executable, which
 * flattens the tree into one file. `resolveBundled` holds the four layouts
 * and why the path differs in each; src/admin.ts finds its manifest through
 * the same resolver.
 *
 * It is absolute either way, so a process that changes its working directory
 * still finds it, and it is probed once and remembered: the assets are read
 * when the server starts, so `tdo --help` pays nothing for this.
 */
let assetDirCache: string | undefined;

function assetDir(): string {
  assetDirCache ??= resolveBundled(import.meta.dirname, path.join('..', '..'), 'assets');
  return assetDirCache;
}

/**
 * Listener is a listening socket with no handler attached yet. It is separate
 * from serving so that `tdo serve` can print the address it actually got —
 * port 0 means "any free port", and the user needs to be told which one.
 *
 * Go had `net.Listener` for this, and `http.Server.Serve` took it. Node's
 * `http.Server` is both halves at once, so the socket is opened here and the
 * request listener is attached by `Server.serve`.
 */
export class Listener {
  readonly http: HTTPServer;

  constructor(http: HTTPServer) {
    this.http = http;
  }

  /**
   * addr is the address actually bound, as `host:port`, the way Go's
   * `ln.Addr().String()` rendered it — an IPv6 host in brackets, so the
   * result is a usable authority in a URL.
   */
  addr(): string {
    const bound = this.http.address();
    if (bound === null || typeof bound === 'string') {
      // A Unix socket, or a server that is not listening. Neither is
      // reachable here: `Listen` only ever binds TCP and only ever returns
      // after `listening`.
      throw new Error('the listener is not bound to a TCP address');
    }
    const host = bound.address.includes(':') ? `[${bound.address}]` : bound.address;
    return `${host}:${bound.port}`;
  }

  /** close releases the socket. It is safe to call twice. */
  async close(): Promise<void> {
    if (!this.http.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
      // A keep-alive connection from the page would otherwise hold the
      // process open long past Ctrl-C; Go's Shutdown closed idle ones for
      // the same reason.
      this.http.closeIdleConnections();
    });
  }
}

/**
 * Listen opens the listener on addr, which is `host:port` — the shape
 * `tdo serve` builds from --addr and --port.
 */
export async function Listen(addr: string): Promise<Listener> {
  const { host, port } = splitHostPort(addr);
  const http = createServer();
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen({ host, port }, () => {
      http.removeListener('error', reject);
      resolve();
    });
  });
  return new Listener(http);
}

/**
 * splitHostPort is `net.SplitHostPort`, for the two spellings `tdo serve`
 * produces: `127.0.0.1:8080` and `[::1]:8080`.
 */
function splitHostPort(addr: string): { host: string; port: number } {
  const at = addr.lastIndexOf(':');
  if (at < 0) {
    throw new Error(`${JSON.stringify(addr)} is not a host:port address`);
  }
  let host = addr.slice(0, at);
  const raw = addr.slice(at + 1);
  const port = raw === '' ? 0 : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${JSON.stringify(addr)} does not name a port`);
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  return { host, port };
}

/**
 * route is one entry of the table that replaces `http.ServeMux`. The matcher
 * is shared with the PWA (`PathMatch`); `serve` is this front end's, because
 * only this one has a socket.
 */
interface route {
  readonly method: string;
  /** match returns the path parameters, or undefined when the path is not this one. */
  readonly match: PathMatch;
  readonly serve: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) => Promise<void>;
}

/** Server serves the viewer over one store. */
export class Server {
  readonly st: Store;
  /**
   * mu serializes requests, because a store is documented as safe for a
   * single caller only.
   */
  readonly mu = new Mutex();
  /**
   * token authorizes a write. It lives for the life of the process and is
   * embedded in the page, so a reload after a restart picks up the new one.
   */
  readonly token: string;
  /** now is the clock, injectable so a test can pin availability. */
  now: () => Date = () => new Date();
  private readonly api: API;
  private readonly page: string;
  private readonly routes: route[];

  /**
   * The constructor is `New`'s, and `New` is the way to build one: it mints
   * the token and reads the assets, both of which can fail.
   */
  constructor(st: Store, token: string, page: string) {
    this.st = st;
    this.token = token;
    this.page = page;
    this.api = new API(st, () => this.now());
    this.routes = this.table();
  }

  private table(): route[] {
    return [
      // The page is rendered rather than served as a file, because it carries
      // the write token and the store's description.
      {
        method: 'GET',
        match: exact('/'),
        serve: async (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          // The page is this process's own state; a stale copy would hold a
          // token that no longer works.
          res.setHeader('Cache-Control', 'no-store');
          res.end(render(this.page, { Token: this.token, Store: this.st.describe() }));
        },
      },
      asset('/app.css', 'app.css', 'text/css; charset=utf-8'),
      asset('/app.js', 'app.js', 'text/javascript; charset=utf-8'),

      // The rest of the shell, which exists so the viewer can be installed
      // to a phone's home screen and behave like an app there.
      asset('/icon-192.png', 'icon-192.png', 'image/png'),
      asset('/icon-512.png', 'icon-512.png', 'image/png'),
      asset('/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'),
      // Two files no extension table has a media type for, and a browser
      // refuses both when they arrive as something else.
      asset('/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json'),
      // The worker caches nothing (see the file); it is revalidated rather
      // than cached itself, because a stale worker is the one thing a phone
      // cannot be made to let go of.
      asset('/sw.js', 'sw.js', 'text/javascript; charset=utf-8'),

      this.read('GET', exact('/api/state'), this.api.handleState),
      this.write('POST', exact('/api/tasks'), this.api.handleCreate),
      this.write('PATCH', taskPath(''), this.api.handleEdit),
      this.write('DELETE', taskPath(''), this.api.handleRemove),
      this.write('POST', taskPath('done'), this.api.handleDone),
      this.write('POST', taskPath('status'), this.api.handleStatus),
      this.write('POST', taskPath('flag'), this.api.handleFlag),
      this.write('POST', taskPath('date'), this.api.handleDate),
      this.write('POST', taskPath('move'), this.api.handleMove),
    ];
  }

  /** read wraps a GET endpoint: the mutex, and the JSON encoding. */
  private read(method: string, match: PathMatch, fn: Handler): route {
    return {
      method,
      match,
      serve: async (req, res, params) => {
        const r = await request(req, res, params);
        if (r === undefined) {
          return;
        }
        const release = await this.mu.lock();
        try {
          respond(res, await fn(r));
        } catch (err) {
          fail(res, err);
        } finally {
          release();
        }
      },
    };
  }

  /**
   * write wraps a mutating endpoint: the token check and a JSON content type,
   * then the same. Both checks are about a cross-origin request — a form post
   * from another page cannot set either one.
   */
  private write(method: string, match: PathMatch, fn: Handler): route {
    return {
      method,
      match,
      serve: async (req, res, params) => {
        if (!this.authorized(req)) {
          httpError(
            res,
            403,
            'forbidden',
            'this request carries no valid write token; reload the page',
          );
          return;
        }
        const ct = header(req, 'content-type') ?? '';
        if (contentLength(req) !== 0 && !ct.startsWith('application/json')) {
          httpError(res, 415, 'usage', 'the API takes application/json');
          return;
        }
        const r = await request(req, res, params);
        if (r === undefined) {
          return;
        }
        const release = await this.mu.lock();
        try {
          respond(res, await fn(r));
        } catch (err) {
          fail(res, err);
        } finally {
          release();
        }
      },
    };
  }

  /**
   * authorized compares the token in constant time, so that a wrong guess
   * tells the caller nothing about how wrong it was.
   *
   * `timingSafeEqual` throws on a length mismatch where Go's
   * `subtle.ConstantTimeCompare` returned 0, so the lengths are compared
   * first. That leaks the length of the token, which is a constant.
   */
  authorized(req: IncomingMessage): boolean {
    const given = Buffer.from(header(req, TokenHeader) ?? '', 'utf8');
    const want = Buffer.from(this.token, 'utf8');
    if (given.length !== want.length) {
      return false;
    }
    return timingSafeEqual(given, want);
  }

  /**
   * handle answers one request. It is the request listener `node:http` takes,
   * and Go's `ServeHTTP`.
   */
  handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // No CORS header is set anywhere in this module, on any path, including
      // this one: another origin's script may reach the port, and the browser
      // must refuse to show it what came back. There is no Origin check
      // either, because there is nothing to allow.
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      let wrongMethod = false;
      for (const r of this.routes) {
        const params = r.match(pathname);
        if (params === undefined) {
          continue;
        }
        if (r.method !== req.method) {
          wrongMethod = true;
          continue;
        }
        await r.serve(req, res, params);
        return;
      }
      if (wrongMethod) {
        httpError(res, 405, 'usage', `${String(req.method)} is not allowed here`);
        return;
      }
      httpError(res, 404, 'not_found', 'no such endpoint');
    } catch (err) {
      fail(res, err);
    }
  };

  /**
   * serve answers requests until signal is aborted, then shuts down. The
   * promise resolves on a clean stop and rejects on a listener failure, which
   * is what Go's `Serve` returned.
   */
  async serve(ln: Listener, signal?: AbortSignal): Promise<void> {
    ln.http.on('request', this.handle);
    // A local viewer has no reason to hold a request open for long, and a
    // header timeout is the cheapest protection against a connection that
    // never finishes talking.
    ln.http.headersTimeout = 10_000;
    ln.http.requestTimeout = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        const stop = (): void => {
          // Go gave Shutdown a deadline of its own, because the parent
          // context was already cancelled. Node's close waits for the
          // in-flight requests and nothing else, and the idle connections
          // are closed with it.
          void ln.close().then(resolve, reject);
        };
        if (signal !== undefined) {
          if (signal.aborted) {
            stop();
            return;
          }
          signal.addEventListener('abort', stop, { once: true });
        }
        ln.http.once('error', reject);
        ln.http.once('close', () => resolve());
      });
    } finally {
      ln.http.removeListener('request', this.handle);
    }
  }
}

/**
 * New builds a server over st. It throws only if the assets cannot be read or
 * the page cannot be parsed, which in Go would have been a build problem: see
 * the note about `go:embed` at the top of this module.
 */
export function New(st: Store): Server {
  const page = read('index.html').toString('utf8');
  checkTemplate(page);
  return new Server(st, newToken(), page);
}

/**
 * newToken mints the write token: 32 bytes of randomness, which is far more
 * than a local listener needs and no harder to produce. The encoding is
 * base64url with no padding, so the token is one word in a header and in an
 * HTML attribute.
 */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** read loads one asset, naming the directory when it is not there. */
function read(name: string): Buffer {
  try {
    return readFileSync(path.join(assetDir(), name));
  } catch (err) {
    throw new Error(
      `could not read the viewer asset ${name} from ${assetDir()}`,
      { cause: err },
    );
  }
}

/**
 * asset serves one file under a media type of our choosing. Go had
 * `http.FileServerFS` for most of these and a hand-written handler for the
 * two it had no media type for; there is no file server here, so one helper
 * covers all of them, every type is named and every one is revalidated
 * rather than cached. A cached asset beside an uncached page is how a phone
 * ends up running last week's script against this week's token.
 */
function asset(urlPath: string, name: string, contentType: string): route {
  return {
    method: 'GET',
    match: exact(urlPath),
    serve: async (_req, res, _params) => {
      const body = read(name);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.end(body);
    },
  };
}

/** header reads one request header, folded to a single value. */
function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

/**
 * contentLength is Go's `r.ContentLength`: the declared length of the body, 0
 * when there is no body at all, and -1 when a body arrives with no length —
 * which over HTTP/1.1 means a chunked one.
 *
 * The three cases have to stay distinct because two checks turn on them. A
 * request with neither header has no body, which is how `fetch` sends a
 * DELETE and how Go's `http.NewRequest` with no reader described one, and
 * both the content-type check and `optionalBody` have to let it through.
 */
function contentLength(req: IncomingMessage): number {
  const raw = header(req, 'content-length');
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) {
      return n;
    }
  }
  return header(req, 'transfer-encoding') === undefined ? 0 : -1;
}

/**
 * request reads the body and builds the Req a handler takes. It answers the
 * request itself and returns undefined when the body cannot be read, which
 * is the one failure that happens before any handler exists to report it.
 *
 * The body is truncated at maxBodyBytes rather than refused, which is what
 * Go's `io.LimitReader` did: a body over the cap is cut, and the cut JSON
 * fails to parse as a usage error. Reading it here rather than inside the
 * handler keeps the socket read outside the mutex.
 */
async function request(
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
): Promise<Req | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (total >= maxBodyBytes) {
        continue;
      }
      chunks.push(buf.subarray(0, maxBodyBytes - total));
      total += buf.length;
    }
  } catch (err) {
    fail(res, err);
    return undefined;
  }
  return {
    params,
    contentLength: contentLength(req),
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

function respond(res: ServerResponse, payload: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** fail maps a thrown error onto a status code and the error envelope. */
function fail(res: ServerResponse, err: unknown): void {
  const [status, code] = statusOf(err);
  httpError(res, status, code, messageOf(err));
}

/**
 * httpError writes the envelope `errorEnvelope` describes onto this front
 * end's response. The shape is shared with `--json` and with the PWA; what is
 * local here is the `headersSent` case, which only a socket has.
 */
function httpError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    // The response is already begun, so there is nothing to say but to stop
    // writing.
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(errorEnvelope(code, message)));
}

/**
 * actions are the only two substitutions `index.html` may contain. Go's
 * `template.ParseFS` would have failed on a template it could not parse;
 * this fails on one that names something this module cannot supply, which is
 * the same class of build-time mistake caught at startup.
 */
const actions = ['Token', 'Store'] as const;

function checkTemplate(page: string): void {
  for (const found of page.matchAll(/\{\{([^}]*)\}\}/g)) {
    const name = (found[1] ?? '').trim().replace(/^\./, '');
    if (!actions.includes(name as (typeof actions)[number])) {
      throw new Error(`index.html names an unknown template action {{${found[1] ?? ''}}}`);
    }
  }
}

/**
 * render substitutes the two actions, escaping both. `html/template` escaped
 * contextually; the values land in an HTML attribute and in element text, and
 * escaping the five characters that matter is correct in both places.
 */
function render(page: string, data: Record<(typeof actions)[number], string>): string {
  return page.replace(/\{\{([^}]*)\}\}/g, (_whole, raw: string) => {
    const name = raw.trim().replace(/^\./, '') as (typeof actions)[number];
    return escapeHTML(data[name]);
  });
}

function escapeHTML(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&#34;')
    .replaceAll("'", '&#39;');
}
