// The transport: one POST of a /v2/pipeline request per round trip.
//
// Nothing here imports `node:*`. The request is made with the global `fetch`,
// so the same client runs in the CLI and in the browser, which is the whole
// reason this provider exists in its own package (MIGRATION.md).
//
// Port notes:
//
//   - Go's `context.Context` is gone from the Store interface, so the
//     cancellation and deadline handling moves here: the timeout is a
//     constructor option and is applied with `AbortSignal.timeout`, and an
//     aborted request is reported as a timeout naming the host.
//   - `*http.Client` is a `fetch` function, which is the same seam: the tests
//     pass one pointed at a local server.

import {
  clip,
  decodeResponse,
  messageOf,
  parseWire,
  protoErrorText,
  type ExecuteResult,
  type PipelineResponse,
  type ProtoError,
  type Statement,
} from './protocol.ts';
import { REDACTED, Secret } from '@todocloud/core/secret';
import { configf, providerf } from '@todocloud/core/exit';

/**
 * The two classifiers, with Go's `error`-returning signature narrowed: core's
 * `configf` and `providerf` return `Error | null` because Go's returned nil
 * for nil, and every call here passes a real error.
 */
function configError(err: Error): Error {
  return configf(err) as Error;
}

function providerError(err: Error): Error {
  return providerf(err) as Error;
}

/**
 * pipelinePath is the only path this package ever requests. There is no code
 * here that reaches the Turso platform API: this provider executes SQL
 * against the database its URL names and can neither create nor destroy a
 * database. The endpoint test asserts that invariant against a recording
 * server.
 */
export const pipelinePath = '/v2/pipeline';

/**
 * maxErrorBody bounds how much of a failed response is read before it is
 * summarised. A server that answers with an HTML error page or an endless
 * stream must not be allowed to fill memory on the way to an error message.
 */
export const maxErrorBody = 8 << 10;

/**
 * maxResponseBody bounds a successful response too. A task list is kilobytes;
 * anything past this is a server that is not answering the question asked.
 */
export const maxResponseBody = 256 << 20;

/** Fetch is the shape of the global fetch this client uses. */
export type Fetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

/** client speaks the libSQL remote protocol to one database. */
export class Client {
  readonly endpoint: string;
  readonly host: string;
  readonly token: Secret;
  private readonly fetchImpl: Fetch;
  /** timeoutMs bounds one round trip; 0 means no timeout of our own. */
  private readonly timeoutMs: number;

  constructor(
    endpoint: string,
    host: string,
    token: Secret,
    fetchImpl: Fetch,
    timeoutMs: number,
  ) {
    this.endpoint = endpoint;
    this.host = host;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * withTimeout returns the same client with a different deadline. It is how
   * openExisting gives its one probe a shorter one than a command gets,
   * without a second endpoint to keep in step.
   */
  withTimeout(timeoutMs: number): Client {
    return new Client(
      this.endpoint,
      this.host,
      this.token,
      this.fetchImpl,
      timeoutMs,
    );
  }

  /**
   * pipeline executes stmts in one round trip and returns one result per
   * statement, in order. The stream is opened and closed by this request, so
   * the client holds no server-side state between calls: there is no baton to
   * track and nothing to leak if the process dies mid-command.
   */
  async pipeline(...stmts: Statement[]): Promise<ExecuteResult[]> {
    const body = {
      requests: [
        ...stmts.map((stmt) => ({ type: 'execute', stmt })),
        { type: 'close' },
      ],
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (!this.token.empty()) {
      // The one place the credential is revealed. It never reaches the URL,
      // a log line or an error message.
      headers['Authorization'] = 'Bearer ' + this.token.reveal();
    }

    let resp: Response;
    try {
      resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(this.timeoutMs > 0
          ? { signal: AbortSignal.timeout(this.timeoutMs) }
          : {}),
      });
    } catch (err) {
      // The deadline is this provider's own doing, so it is reported as the
      // deadline rather than as a broken database. Neither branch may name
      // anything but the host: the request carries the credential.
      if (isAbort(err)) {
        throw providerError(
          new Error(
            `turso: request to ${this.host} timed out after ${this.timeoutMs}ms`,
            { cause: err },
          ),
        );
      }
      throw providerError(
        new Error(`turso: request to ${this.host}: ${messageOf(err)}`, {
          cause: err,
        }),
      );
    }

    if (Math.trunc(resp.status / 100) !== 2) {
      throw await this.statusError(resp);
    }

    let decoded: PipelineResponse;
    try {
      decoded = decodePipelineResponse(
        await readBounded(resp, maxResponseBody),
      );
    } catch (err) {
      throw providerError(
        new Error(`turso: ${this.host}: ${messageOf(err)}`, { cause: err }),
      );
    }
    return this.results(decoded, stmts.length);
  }

  /**
   * scrub removes the credential from text the server sent us.
   *
   * It is the last line of the promise in SECURITY.md that `tdo` never prints
   * a token. A proxy or a misconfigured sqld can echo the Authorization
   * header back in its error page, and a 500 whose body is "your request said
   * Authorization: Bearer <token>" would otherwise put the credential in the
   * terminal, the scrollback and the issue it gets pasted into — with this
   * tool having disclosed it, even though it was the far end that repeated
   * it. Everything that reaches an error message from the far end goes
   * through here first.
   */
  private scrub(s: string): string {
    if (this.token.empty()) {
      return s;
    }
    return s.split(this.token.reveal()).join(REDACTED);
  }

  /**
   * results checks the per-statement outcomes and returns them aligned with
   * the statements that were sent.
   */
  private results(resp: PipelineResponse, want: number): ExecuteResult[] {
    if (resp.error !== undefined && resp.error !== 'null') {
      throw providerError(
        new Error(
          `turso: ${this.host} refused the request: ${clip(this.scrub(resp.error))}`,
        ),
      );
    }
    // The trailing close request is sent by pipeline, so there is always one
    // result more than there are statements.
    if (resp.results.length < want) {
      throw providerError(
        new Error(
          `turso: ${this.host} answered ${resp.results.length} statement(s), ${want} were sent`,
        ),
      );
    }
    const out: ExecuteResult[] = [];
    for (let i = 0; i < want; i++) {
      const res = resp.results[i] as PipelineResponse['results'][number];
      switch (res.type) {
        case 'error':
          // The engine's own text is the far end's, so it is scrubbed like
          // any other text that came back over the wire.
          throw new RemoteError(
            this.host,
            res.error === undefined
              ? undefined
              : {
                  message: this.scrub(res.error.message),
                  code: this.scrub(res.error.code),
                },
          );
        case 'ok':
          if (res.result === undefined) {
            throw providerError(
              new Error(
                `turso: ${this.host} returned no result for statement ${i + 1}`,
              ),
            );
          }
          out.push(res.result);
          break;
        case '':
          throw providerError(
            new Error(
              `turso: ${this.host} returned an untyped result for statement ${i + 1}`,
            ),
          );
        default:
          throw providerError(
            new Error(
              `turso: ${this.host} returned an unknown result type ${JSON.stringify(res.type)}`,
            ),
          );
      }
    }
    return out;
  }

  /**
   * statusError turns a non-2xx response into the clearest error the status
   * allows. 401 and 403 are credential problems and classified as such, so
   * that the process exits 3 and the advice points at `tdo login` rather than
   * at the network.
   */
  private async statusError(resp: Response): Promise<Error> {
    const snippet = this.scrub(await readSnippet(resp));
    switch (resp.status) {
      case 401:
        return configError(
          new Error(
            `turso: ${this.host} rejected the auth token (HTTP 401); run \`tdo login\` to store a fresh per-database token, or set TODOCLOUD_TURSO_TOKEN`,
          ),
        );
      case 403:
        return configError(
          new Error(
            `turso: ${this.host} refused the auth token (HTTP 403); the token may not grant access to this database — run \`tdo login\` to mint one for it`,
          ),
        );
      case 404:
        return providerError(
          new Error(
            `turso: ${this.host} has no database at ${pipelinePath} (HTTP 404); check turso.url`,
          ),
        );
    }
    if (snippet === '') {
      return providerError(
        new Error(`turso: ${this.host} returned HTTP ${resp.status}`),
      );
    }
    return providerError(
      new Error(
        `turso: ${this.host} returned HTTP ${resp.status}: ${snippet}`,
      ),
    );
  }
}

/**
 * endpointFor turns a configured database URL into the pipeline endpoint.
 *
 * A libsql:// URL is the https:// URL of the same host; http:// is accepted
 * for a self-hosted sqld and for the tests. A URL carrying a query string,
 * a fragment or userinfo is refused outright: Turso's own tooling sometimes
 * writes the token into `?authToken=`, and this project does not put a
 * credential in a URL — it travels in the Authorization header or not at all.
 *
 * Go used net/url. This parses the authority by hand rather than through
 * `URL`, because the three refusals above have to be answerable exactly: the
 * `URL` class normalises a bare `?` away, so `libsql://example.turso.io?`
 * would be indistinguishable from a clean URL — and that spelling is one
 * keystroke from a token in a query string.
 */
export function endpointFor(raw: string): { endpoint: string; host: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('turso: no database URL configured');
  }
  const parts = /^([A-Za-z][A-Za-z0-9+.\-]*):(.*)$/.exec(trimmed);
  if (parts === null) {
    throw new Error(
      `turso: database URL ${clip(trimmed)} has no scheme; it should look like libsql://example.turso.io`,
    );
  }
  const scheme = (parts[1] as string).toLowerCase();
  let wire: string;
  switch (scheme) {
    case 'libsql':
    case 'https':
    case 'wss':
      wire = 'https';
      break;
    case 'http':
    case 'ws':
      wire = 'http';
      break;
    default:
      throw new Error(
        `turso: unsupported database URL scheme ${JSON.stringify(scheme)}; use libsql:// or https://`,
      );
  }

  let rest = parts[2] as string;
  // Everything from the first '?' or '#' is a query string or a fragment, and
  // neither is allowed; which one it is decides the message.
  const query = rest.indexOf('?');
  const fragment = rest.indexOf('#');
  const cut =
    query < 0 ? fragment : fragment < 0 ? query : Math.min(query, fragment);
  const tail = cut < 0 ? '' : rest.slice(cut);
  if (cut >= 0) {
    rest = rest.slice(0, cut);
  }

  if (!rest.startsWith('//')) {
    throw new Error(`turso: database URL ${clip(trimmed)} names no host`);
  }
  rest = rest.slice(2);
  const slash = rest.indexOf('/');
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? '' : rest.slice(slash);

  if (authority.includes('@')) {
    throw new Error(
      'turso: the database URL must not carry credentials; the token travels in the Authorization header',
    );
  }
  if (tail.startsWith('?')) {
    throw new Error(
      'turso: the database URL must not carry a query string; a token in a URL is logged by every proxy in the path',
    );
  }
  if (tail.startsWith('#')) {
    throw new Error('turso: the database URL must not carry a fragment');
  }
  if (authority === '') {
    throw new Error(`turso: database URL ${clip(trimmed)} names no host`);
  }

  const base = path.endsWith('/') ? path.slice(0, -1) : path;
  return {
    endpoint: wire + '://' + authority + base + pipelinePath,
    host: authority,
  };
}

/**
 * decodePipelineResponse reads the response body. It is split out so that a
 * test can reach it with no server in the way: it is the only parser in this
 * package that reads bytes the CLI did not write.
 */
export function decodePipelineResponse(text: string): PipelineResponse {
  if (text.trim() === '') {
    throw new Error('the response ended before it was complete');
  }
  let parsed: unknown;
  try {
    parsed = parseWire(text);
  } catch (err) {
    const msg = messageOf(err);
    if (/unterminated|end of (the )?(json )?(input|data)|unexpected end/i.test(msg)) {
      throw new Error('the response ended before it was complete');
    }
    throw new Error(
      `the response is not a libSQL pipeline reply: ${msg}`,
      { cause: err },
    );
  }
  return decodeResponse(parsed);
}

/**
 * remoteError carries a failed statement's report from the server. It exists
 * so that the mapping in turso.ts can inspect the engine's text in one place
 * and decide whether the user sees a sentinel instead.
 */
export class RemoteError extends Error {
  override readonly name = 'RemoteError';
  readonly host: string;
  readonly proto: ProtoError | undefined;

  constructor(host: string, proto: ProtoError | undefined) {
    const text = protoErrorText(proto);
    super(
      text === ''
        ? `turso: ${host} rejected the statement`
        : `turso: ${host}: ${text}`,
    );
    this.host = host;
    this.proto = proto;
  }

  /** message returns the engine's text, for classification only. */
  engineText(): string {
    if (this.proto === undefined) {
      return '';
    }
    return this.proto.message + ' ' + this.proto.code;
  }
}

/** isRemoteError reports whether err, or anything it wraps, is a RemoteError. */
export function isRemoteError(err: unknown): RemoteError | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    if (cur instanceof RemoteError) {
      return cur;
    }
    seen.add(cur);
    cur = typeof cur === 'object' && 'cause' in cur ? cur.cause : undefined;
  }
  return undefined;
}

/**
 * readSnippet reads a bounded, sanitized piece of a failed response, so that
 * an HTML error page from a proxy is reported as a short quoted string rather
 * than pasted into the terminal.
 */
async function readSnippet(resp: Response): Promise<string> {
  try {
    const raw = await readBounded(resp, maxErrorBody);
    if (raw.trim() === '') {
      return '';
    }
    return clip(raw);
  } catch {
    return '';
  }
}

/**
 * readBounded reads at most max bytes of a response and decodes them as UTF-8.
 * It streams where the runtime offers a body reader, so an endless response is
 * abandoned rather than buffered.
 */
async function readBounded(resp: Response, max: number): Promise<string> {
  const body = resp.body;
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    const text = await resp.text();
    return text.length > max ? text.slice(0, max) : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      chunks.push(value);
      total += value.length;
      if (total >= max) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const chunk of chunks) {
    if (at >= joined.length) {
      break;
    }
    const take = Math.min(chunk.length, joined.length - at);
    joined.set(chunk.subarray(0, take), at);
    at += take;
  }
  return new TextDecoder().decode(joined);
}

/** isAbort reports whether a rejected fetch was our own timeout. */
function isAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export { configError, providerError };
