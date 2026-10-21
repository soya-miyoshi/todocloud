// Test-only helpers, shared by the two test files of this directory the way
// Go's `web_test.go` shared its `harness` with the rest of the package. It is
// not part of the package's exports map: nothing outside `*.test.ts` here may
// import it.
//
// Go called the handler in process through `httptest`. These tests use a real
// socket on 127.0.0.1:0 instead, for two reasons: the mutex is the thing most
// worth testing and it only means anything where two requests genuinely
// overlap, and port 0 lets the kernel pick, so parallel test files cannot
// collide. Nothing here reaches the network or a real store — the store is
// `:memory:`, which cannot outlive the test.

import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { MemoryPath, open } from "@todocloud/store-sqlite";
import type { Store } from "@todocloud/core/store";

import { Listen, type Listener, New, type Server, TokenHeader } from "./web.ts";

/**
 * A token no real process would mint: 32 random bytes land as 43 base64url
 * characters, and this is an obvious placeholder, as CLAUDE.md §1.3 requires
 * of every credential-shaped literal in the tree.
 */
export const fakeToken = "TOKEN_GOES_HERE-not-a-real-write-token";

/**
 * pinnedNow is the clock every harness runs on, so an availability answer is
 * a truth table and not a race against midnight.
 */
export const pinnedNow = new Date("2026-03-02T09:00:00Z");

/** Answer is one response, read far enough to assert about. */
export interface Answer {
  readonly status: number;
  readonly payload: Record<string, unknown> | undefined;
  readonly text: string;
  readonly headers: Headers;
}

/** Harness is a listening server over an initialized in-memory store. */
export class Harness {
  readonly srv: Server;
  readonly ln: Listener;
  readonly st: Store;
  readonly base: string;

  private constructor(srv: Server, ln: Listener, st: Store) {
    this.srv = srv;
    this.ln = ln;
    this.st = st;
    this.base = `http://${ln.addr()}`;
  }

  static async start(t: TestContext): Promise<Harness> {
    const st = open(MemoryPath);
    await st.init();
    const srv = New(st);
    srv.now = () => pinnedNow;
    const ln = await Listen("127.0.0.1:0");
    const stop = new AbortController();
    const serving = srv.serve(ln, stop.signal);
    t.after(async () => {
      stop.abort();
      await serving;
      await st.close();
    });
    return new Harness(srv, ln, st);
  }

  /** do sends a request with the write token attached. */
  async do(method: string, path: string, body?: unknown): Promise<Answer> {
    return this.send(method, path, body, this.srv.token, "application/json");
  }

  /** send is `do` with the token and the content type spelled out. */
  async send(
    method: string,
    path: string,
    body: unknown,
    token: string,
    contentType: string,
  ): Promise<Answer> {
    const headers: Record<string, string> = {};
    if (token !== "") {
      headers[TokenHeader] = token;
    }
    if (contentType !== "" && body !== undefined) {
      headers["content-type"] = contentType;
    }
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let payload: Record<string, unknown> | undefined;
    if (text.trimStart().startsWith("{")) {
      payload = JSON.parse(text) as Record<string, unknown>;
    }
    return { status: res.status, payload, text, headers: res.headers };
  }

  /** add captures an item and returns its id. */
  async add(body: Record<string, unknown>): Promise<string> {
    const { status, payload } = await this.do("POST", "/api/tasks", body);
    assert.equal(status, 200, `create: ${JSON.stringify(payload)}`);
    const tasks = payload?.["tasks"];
    assert.ok(
      Array.isArray(tasks) && tasks.length === 1,
      `a write answers with one task in the listing shape: ${JSON.stringify(payload)}`,
    );
    const created = tasks[0] as Record<string, unknown>;
    const taskID = created["id"];
    assert.equal(typeof taskID, "string", `create: no id in ${JSON.stringify(created)}`);
    return taskID as string;
  }

  /** tasks is the state response's listing. */
  async tasks(): Promise<Record<string, unknown>[]> {
    const { status, payload } = await this.send(
      "GET",
      "/api/state",
      undefined,
      this.srv.token,
      "",
    );
    assert.equal(status, 200, `state: ${JSON.stringify(payload)}`);
    return (payload?.["tasks"] ?? []) as Record<string, unknown>[];
  }

  /** find is the one task with this id, as the state response renders it. */
  async find(taskID: string): Promise<Record<string, unknown>> {
    for (const t of await this.tasks()) {
      if (t["id"] === taskID) {
        return t;
      }
    }
    return assert.fail(`${taskID} is not in the state response`);
  }
}

/** errorCode reads the `code` out of the API's error envelope. */
export function errorCode(a: Answer): unknown {
  const envelope = a.payload?.["error"];
  if (envelope === undefined || envelope === null || typeof envelope !== "object") {
    return assert.fail(`no error envelope in ${a.text}`);
  }
  return (envelope as Record<string, unknown>)["code"];
}
