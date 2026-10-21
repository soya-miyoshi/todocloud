// The tests never touch a real Turso account: every one of them runs against
// the fake pipeline server below, which speaks the libSQL remote protocol and
// executes the statements it receives on a private in-memory SQLite database.
//
// Backing the fake with a real engine is the point. A hand-written stub would
// answer whatever the test expected, and the behaviour this provider has to
// reproduce — the ordering, the LIKE ESCAPE semantics, the primary-key
// conflict, "no such table" — is the engine's, not the stub author's.
//
// Port notes: Go used net/http/httptest and modernc.org/sqlite. This is
// `node:http` listening on 127.0.0.1:0 — a port the OS picks, so two test
// files never collide — and `node:sqlite`, which is built in. Both are
// `node:*` imports, which only a test file in this package may have: the
// source files run in a browser too.

import { type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import { Secret } from '@todocloud/core/secret';
import { Task, newTask, formatTime, type Fields } from '@todocloud/core/task';
import { KindTask } from '@todocloud/core/task';

import { pipelinePath } from './client.ts';
import {
  Value,
  kindBlob,
  kindFloat,
  kindInteger,
  kindNull,
  kindText,
  valueFromJSON,
  type ProtoAny,
} from './protocol.ts';
import { open, type Config, type Store } from './turso.ts';

/**
 * testToken is the only token in this package. It is an obvious placeholder:
 * nothing here, and nothing in the repository, may contain a realistic one.
 */
export const testToken = 'TOKEN_GOES_HERE';

/**
 * exampleURL is the placeholder database URL used wherever a real-looking
 * host would otherwise appear.
 */
export const exampleURL = 'libsql://example.turso.io';

/**
 * recorded is what the fake server remembers about one request, so that a
 * test can assert on where the client went and what it sent.
 */
export interface Recorded {
  method: string;
  path: string;
  rawQuery: string;
  requestURI: string;
  auth: string;
  body: string;
}

/** An intercept replaces the pipeline handler; false falls through to it. */
export type Intercept = (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean;

/** fakeServer is an HTTP server that answers /v2/pipeline. */
export class FakeServer {
  readonly db: DatabaseSync;
  readonly server: Server;
  readonly url: string;
  private readonly requests: Recorded[] = [];
  /**
   * intercept, when set, replaces the pipeline handler entirely. It is how
   * the HTTP failure modes are driven; returning false falls through to the
   * normal handler.
   */
  intercept: Intercept | undefined;

  constructor(db: DatabaseSync, server: Server, url: string) {
    this.db = db;
    this.server = server;
    this.url = url;
  }

  /** seen returns the requests received so far. */
  seen(): Recorded[] {
    return [...this.requests];
  }

  /** record is called by the handler before anything else happens. */
  private record(r: Recorded): void {
    this.requests.push(r);
  }

  /** serve is the handler. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const target = req.url ?? '/';
    const q = target.indexOf('?');
    this.record({
      method: req.method ?? '',
      path: q < 0 ? target : target.slice(0, q),
      rawQuery: q < 0 ? '' : target.slice(q + 1),
      requestURI: target,
      auth: headerOf(req, 'authorization'),
      body,
    });

    if (this.intercept !== undefined && this.intercept(req, res)) {
      return;
    }
    const path = q < 0 ? target : target.slice(0, q);
    if (path !== pipelinePath) {
      plainText(res, 404, 'not found');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      plainText(res, 400, 'bad request');
      return;
    }
    const requests = (parsed as { requests?: unknown }).requests;
    if (!Array.isArray(requests)) {
      plainText(res, 400, 'bad request');
      return;
    }

    const results: unknown[] = [];
    for (const one of requests as unknown[]) {
      const entry = one as { type?: unknown; stmt?: unknown };
      switch (entry.type) {
        case 'close':
          results.push({ type: 'ok', response: { type: 'close' } });
          break;
        case 'execute':
          results.push(this.execute(entry.stmt));
          break;
        default:
          results.push({
            type: 'error',
            error: {
              message: 'unsupported request type ' + String(entry.type),
              code: 'UNSUPPORTED',
            },
          });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
  }

  /**
   * execute runs one statement on the engine and renders the outcome the way
   * the protocol does.
   */
  private execute(raw: unknown): unknown {
    if (typeof raw !== 'object' || raw === null) {
      return {
        type: 'error',
        error: { message: 'no statement', code: 'ARGS_INVALID' },
      };
    }
    const stmt = raw as { sql?: unknown; args?: unknown; want_rows?: unknown };
    if (typeof stmt.sql !== 'string') {
      return {
        type: 'error',
        error: { message: 'no statement', code: 'ARGS_INVALID' },
      };
    }
    const args: ProtoAny[] = [];
    for (const a of (stmt.args ?? []) as unknown[]) {
      args.push(valueFromJSON(a).any);
    }
    const wantRows = stmt.want_rows === true;

    const fail = (err: unknown): unknown => {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: 'error',
        error: { message, code: sqliteCode(message) },
      };
    };

    try {
      const prepared = this.db.prepare(stmt.sql);
      prepared.setReadBigInts(true);
      if (isQuery(stmt.sql)) {
        const names = prepared.columns().map((c) => c.name);
        const rows = prepared.all(...(args as never[]));
        const out: unknown[] = [];
        if (wantRows) {
          for (const row of rows) {
            out.push(
              names.map((name) =>
                goToProto((row as Record<string, unknown>)[name as string]).toJSON(),
              ),
            );
          }
        }
        return {
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: names.map((name) => ({ name })),
              rows: out,
              affected_row_count: '0',
            },
          },
        };
      }
      const info = prepared.run(...(args as never[]));
      return {
        type: 'ok',
        response: {
          type: 'execute',
          result: {
            cols: [],
            rows: [],
            affected_row_count: String(info.changes),
          },
        },
      };
    } catch (err) {
      return fail(err);
    }
  }

  /** config returns a Config pointed at this server. */
  config(): Config {
    return { url: this.url, token: new Secret(testToken) };
  }
}

/** newFakeServer starts a server and closes it when the test ends. */
export async function newFakeServer(t: TestContext): Promise<FakeServer> {
  const db = new DatabaseSync(':memory:');
  let fake: FakeServer | undefined;
  const server = createServer((req, res) => {
    void fake?.handle(req, res).catch(() => {
      if (!res.headersSent) {
        plainText(res, 500, 'the fake server failed');
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake server did not report a port');
  }
  fake = new FakeServer(db, server, `http://127.0.0.1:${address.port}`);
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections();
    db.close();
  });
  return fake;
}

/** openStore returns an initialized store talking to a fresh fake server. */
export async function openStore(
  t: TestContext,
): Promise<{ store: Store; fake: FakeServer }> {
  const fake = await newFakeServer(t);
  const store = open(fake.config());
  t.after(() => store.close());
  await store.init();
  return { store, fake };
}

function isQuery(sql: string): boolean {
  return sql.trim().toUpperCase().startsWith('SELECT');
}

/**
 * sqliteCode mimics the SQLITE_* code libSQL puts beside the message, so that
 * the classification in the provider is exercised on both halves.
 */
function sqliteCode(message: string): string {
  const msg = message.toLowerCase();
  if (msg.includes('unique constraint failed')) {
    return 'SQLITE_CONSTRAINT_PRIMARYKEY';
  }
  return 'SQLITE_UNKNOWN';
}

/** goToProto renders a scanned value as a protocol value. */
export function goToProto(v: unknown): Value {
  if (v === null || v === undefined) {
    return new Value(kindNull);
  }
  switch (typeof v) {
    case 'bigint':
      return new Value(kindInteger, v);
    case 'number':
      return new Value(kindFloat, v);
    case 'string':
      return new Value(kindText, v);
    case 'boolean':
      return new Value(kindInteger, v ? 1n : 0n);
    default:
      break;
  }
  if (v instanceof Uint8Array) {
    return new Value(kindBlob, v);
  }
  if (v instanceof Date) {
    return new Value(kindText, formatTime(v));
  }
  return new Value(kindText, '');
}

function headerOf(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (raw === undefined) {
    return '';
  }
  return Array.isArray(raw) ? (raw[0] ?? '') : raw;
}

function plainText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body + '\n');
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Literal ids for the tests that need a deterministic order or a shared
 * prefix. They are 26-character Crockford base32, upper case, no I/L/O/U.
 */
export const idA = '01J3ABCDEFGHJKMNPQRSTVWXYZ';
export const idB = '01J3BBCDEFGHJKMNPQRSTVWXYZ';
export const idC = '01J3CBCDEFGHJKMNPQRSTVWXYZ';
export const idB2 = '01J3BBCDEFGHJKMNPQRSTVWXY0';

/**
 * testNow is the fixed clock every task in this package is built with, so
 * that an ordering is an ordering and not a race.
 */
export const testNow = new Date('2026-03-04T05:06:07Z');

/** newTestTask builds a valid action with the given id and user-defined fields. */
export function newTestTask(
  taskID: string,
  title: string,
  fields?: Fields,
): Task {
  const t = newTask(taskID, KindTask, title, testNow);
  if (fields !== undefined) {
    t.fields = fields;
  }
  return t;
}

/**
 * tokenForTest returns the placeholder credential. It is a function so that
 * every call site reads as "a token", never as a value worth copying.
 */
export function tokenForTest(): Secret {
  return new Secret(testToken);
}

// The fake is a test fixture, and its own two tests live in turso.test.ts
// rather than here: every test file in this package imports this one, so a
// test registered here would be registered — and run — once per file.
