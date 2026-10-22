// The transport half of the viewer's tests: the listener, the mutex, the
// write token, the shell that makes the page installable, and the headers
// that are never sent. The harness is in `testsupport.ts`, with the note on
// why these go over a real socket.

import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryPath, open } from "@todocloud/store-sqlite";
import * as store from "@todocloud/core/store";
import * as version from "@todocloud/core/store/version";
import * as edit from "@todocloud/core/taskops/edit";

import * as api from "@todocloud/core/webapi";
import { Listen, Mutex, New, TokenHeader, newToken, statusOf } from "./web.ts";
import { Harness, errorCode, fakeToken } from "./testsupport.ts";

// Go's TestAWriteWithoutTheTokenChangesNothing is the reason the editing UI is
// safe to run: another origin's script can reach the port, but it cannot read
// the page, so it cannot have the token.
test("a write without the token changes nothing", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "keep me" });

  for (const token of ["", fakeToken]) {
    const { status } = await h.send("DELETE", `/api/tasks/${taskID}`, undefined, token, "");
    assert.equal(status, 403, `a write with token ${JSON.stringify(token)}`);
  }
  assert.equal(
    (await h.find(taskID))["deleted_at"],
    null,
    "a rejected write must not have removed anything",
  );
  const { status } = await h.send("DELETE", `/api/tasks/${taskID}`, undefined, h.srv.token, "");
  assert.equal(status, 200, "the real token should be accepted");
});

// A token of the right length and the wrong bytes is the case the constant-
// time comparison exists for, and the one a length check alone would let
// through.
test("a token of the right length and the wrong bytes is refused", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "keep me" });
  const wrong = `${h.srv.token.slice(0, -1)}${h.srv.token.endsWith("A") ? "B" : "A"}`;
  assert.equal(wrong.length, h.srv.token.length);
  const { status } = await h.send("DELETE", `/api/tasks/${taskID}`, undefined, wrong, "");
  assert.equal(status, 403);
});

// Go's TestAFormPostIsRefused covers the other half of the same defence: a
// cross-origin HTML form can be submitted without script, but it cannot set a
// content type the API accepts.
test("a form post is refused", async (t) => {
  const h = await Harness.start(t);
  const { status } = await h.send(
    "POST",
    "/api/tasks",
    { title: "injected" },
    h.srv.token,
    "application/x-www-form-urlencoded",
  );
  assert.equal(status, 415, "a form-encoded write");
  assert.equal((await h.tasks()).length, 0, "a refused write must not have created anything");
});

// A read needs no token — the page has to work before its script runs — and
// that is only safe because nothing lets another origin's script read the
// answer. No CORS header is ever sent, on any path, so the browser refuses to
// hand a cross-origin caller a response it was never given permission to
// read. A permissive header here would undo the token as well, because the
// page's own script could then be read by anyone.
test("no response carries a CORS header, whatever origin asks", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "visible to nobody else" });
  const forbidden = [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-expose-headers",
    "timing-allow-origin",
  ];

  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/api/state"],
    ["GET", "/app.js"],
    ["GET", "/manifest.webmanifest"],
    ["OPTIONS", "/api/state"],
    ["POST", `/api/tasks/${taskID}/flag`],
    ["DELETE", `/api/tasks/${taskID}`],
  ] as const) {
    // The Origin and the preflight headers a cross-origin attempt would
    // carry. Nothing in this module reads them, which is the point: there is
    // no origin to allow, so there is no header to send.
    const res = await fetch(`${h.base}${path}`, {
      method,
      headers: {
        origin: "https://example.invalid",
        "access-control-request-method": "POST",
        "access-control-request-headers": TokenHeader,
      },
    });
    await res.text();
    for (const name of forbidden) {
      assert.equal(res.headers.get(name), null, `${method} ${path} sent ${name}`);
    }
    assert.equal(res.headers.get("vary"), null, `${method} ${path} varies on something`);
  }
});

// The mutex. Go's guarantee was that a handler ran to completion before the
// next one started, because it held a `sync.Mutex` and a goroutine does not
// yield. Node's handlers interleave at every `await`, so the guarantee has to
// be shown rather than assumed: the store below records when it is entered
// and left, and an unserialized pair would read enter, enter, exit, exit.
test("two overlapping requests do not interleave", async (t) => {
  const h = await Harness.start(t);
  await h.add({ title: "first" });
  await h.add({ title: "second" });

  const log: string[] = [];
  const real = h.st.list.bind(h.st);
  let seq = 0;
  h.st.list = async (f) => {
    const mine = ++seq;
    log.push(`enter ${mine}`);
    // A real await in the middle of the store call, which is where an
    // unserialized handler would hand control to the other request.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const out = await real(f);
    log.push(`exit ${mine}`);
    return out;
  };

  const both = await Promise.all([h.tasks(), h.tasks()]);
  assert.deepEqual(log, ["enter 1", "exit 1", "enter 2", "exit 2"]);
  // And both answers are whole: serialization is only worth having if it does
  // not cost a response.
  for (const tasks of both) {
    assert.equal(tasks.length, 2);
  }
});

// A write and a read overlapping is the pair that matters in practice: the
// page completes an item and refetches its state, and the two must not share
// the store.
test("a write and a read do not share the store", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "water the plants" });

  const log: string[] = [];
  const realUpdate = h.st.update.bind(h.st);
  const realList = h.st.list.bind(h.st);
  h.st.update = async (task) => {
    log.push("write in");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await realUpdate(task);
    log.push("write out");
  };
  h.st.list = async (f) => {
    log.push("read in");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const out = await realList(f);
    log.push("read out");
    return out;
  };

  const [written] = await Promise.all([
    h.do("POST", `/api/tasks/${taskID}/flag`, { flagged: true }),
    h.tasks(),
  ]);
  assert.equal(written.status, 200);
  // Which of the two arrives first is the kernel's business; that neither
  // runs inside the other is this module's.
  assert.ok(
    log.join(", ") === "write in, write out, read in, read out" ||
      log.join(", ") === "read in, read out, write in, write out",
    `the two writes interleaved: ${log.join(", ")}`,
  );
});

// The queue itself, in isolation: it is FIFO, and a holder that never
// releases stops everything behind it rather than letting one through.
test("the mutex is a queue, in order", async () => {
  const mu = new Mutex();
  const order: number[] = [];
  const first = await mu.lock();
  const waiting = [1, 2, 3].map(async (n) => {
    const release = await mu.lock();
    order.push(n);
    release();
  });
  // Nothing may proceed while the first lock is held, however many turns of
  // the event loop go by.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, []);
  first();
  await Promise.all(waiting);
  assert.deepEqual(order, [1, 2, 3]);
});

// Go's TestThePageCarriesTheTokenAndNothingElse: the token has to reach the
// script, and the page must not be cached, or a reload after a restart would
// hold one that no longer works.
test("the page carries the token and is not cached", async (t) => {
  const h = await Harness.start(t);
  const res = await fetch(`${h.base}/`);
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.ok(body.includes(h.srv.token), "the page should carry the write token");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  // The store's description is the other substitution, and the template has
  // no action left unrendered.
  assert.ok(body.includes(h.st.describe()));
  assert.equal(body.includes("{{"), false, "an unrendered template action is left in the page");
});

// `app.js` is one file over two shells — this page and the PWA's, which is
// a separate file on purpose — and it looks its furniture up by id. An
// element added to one shell and not the other is a `TypeError` on the next
// render rather than a layout difference, so each shell is held to the ids
// the script reaches for. `packages/pwa/src/shell.test.ts` asserts the same
// thing about the other page.
//
// The furniture is in the page as served rather than in the file on disk, so
// this reads what the server sends.
test("every element app.js looks up by id is in the page", async (t) => {
  const h = await Harness.start(t);
  const html = await (await fetch(`${h.base}/`)).text();
  const js = await (await fetch(`${h.base}/app.js`)).text();

  // `$` is the furniture that has to be there — it throws rather than
  // answering null — and `maybe` is the handful that differs between the two
  // shells. The script says which is which, so this test does not have to
  // carry a list that would go stale.
  const wanted = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'/g)].map((m) => m[1] as string));
  const have = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1] as string));
  const missing = [...wanted].filter((id) => !have.has(id)).sort();
  assert.deepEqual(missing, [], `app.js looks these up and the page has none of them: ${missing.join(", ")}`);
});

// Go's TestShellIsServable covers the files that make the viewer installable.
// A manifest served as text/plain, or an icon that 404s, fails silently in a
// browser: the install option simply never appears.
test("the installable shell is servable", async (t) => {
  const h = await Harness.start(t);
  for (const [path, typ] of [
    ["/manifest.webmanifest", "application/manifest+json"],
    ["/sw.js", "text/javascript"],
    ["/app.js", "text/javascript"],
    ["/app.css", "text/css"],
    ["/icon-192.png", "image/png"],
    ["/icon-512.png", "image/png"],
    ["/apple-touch-icon.png", "image/png"],
  ] as const) {
    const res = await fetch(`${h.base}${path}`);
    const body = await res.arrayBuffer();
    assert.equal(res.status, 200, `GET ${path}`);
    assert.ok(
      (res.headers.get("content-type") ?? "").startsWith(typ),
      `GET ${path}: content type ${res.headers.get("content-type")}, want ${typ}`,
    );
    assert.ok(body.byteLength > 0, `GET ${path}: empty body`);
  }
});

// Go's TestShellCarriesNoToken keeps the token where it belongs. The page is
// the one file that carries it; a browser may keep any of these others
// around, so none of them may hold anything that expires with the process.
test("the shell carries no token", async (t) => {
  const h = await Harness.start(t);
  for (const path of ["/manifest.webmanifest", "/sw.js", "/app.js", "/app.css"]) {
    const res = await fetch(`${h.base}${path}`);
    const body = await res.text();
    assert.equal(body.includes(h.srv.token), false, `GET ${path}: body carries the write token`);
  }
});

// Go's TestWorkerAnswersNothing holds the worker to what it is for. It is
// registered so the page can be installed to a home screen and for nothing
// else; the moment it answers a request from a cache, the phone can show a
// list the store disagrees with, and no devtools window exists there to find
// out why.
test("the service worker answers nothing", async (t) => {
  const h = await Harness.start(t);
  const res = await fetch(`${h.base}/sw.js`);
  const body = await res.text();
  // The comments in that file name both of these in explaining why they are
  // absent, so the assertion is about the code and reads past them.
  const code = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("");
  for (const forbidden of ["respondWith", "caches"]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `the service worker uses ${forbidden}; it is meant to intercept nothing`,
    );
  }
});

// An unknown path is a 404 in the error envelope, and a known path with the
// wrong method is a 405: Go's ServeMux answered both, and the browser's error
// handling reads one shape, so neither may arrive as a plain-text page.
test("an unrouted request answers in the error envelope", async (t) => {
  const h = await Harness.start(t);
  const missing = await h.send("GET", "/nonesuch", undefined, "", "");
  assert.equal(missing.status, 404);
  assert.equal(errorCode(missing), "not_found");

  const wrongMethod = await h.send("GET", "/api/tasks", undefined, h.srv.token, "");
  assert.equal(wrongMethod.status, 405);
  assert.equal(errorCode(wrongMethod), "usage");
});

// newToken is 32 bytes of randomness, spelled so it can sit in a header and
// in an HTML attribute untouched.
test("the write token is random and header-safe", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    const token = newToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(seen.has(token), false, "two tokens the same");
    seen.add(token);
  }
});

// Two servers mint two tokens: the token is per process, so one process's
// page cannot write to another's store.
test("each server mints its own token", async (t) => {
  const first = await Harness.start(t);
  const second = await Harness.start(t);
  assert.notEqual(first.srv.token, second.srv.token);
  const taskID = await second.add({ title: "not yours" });
  const { status } = await second.send(
    "DELETE",
    `/api/tasks/${taskID}`,
    undefined,
    first.srv.token,
    "",
  );
  assert.equal(status, 403);
});

// statusOf is the mapping the browser's error handling is written against.
// The classes are the ones @todocloud/core/exit maps onto exit codes, so a
// failure means the same thing in both front ends.
test("the error classes map onto status codes", () => {
  assert.deepEqual(statusOf(store.ErrNotFound), [404, "not_found"]);
  assert.deepEqual(statusOf(store.ErrAmbiguous), [409, "ambiguous"]);
  assert.deepEqual(statusOf(store.ErrBadParent), [400, "usage"]);
  assert.deepEqual(statusOf(store.ErrCycle), [400, "usage"]);
  assert.deepEqual(statusOf(store.ErrNotEmpty), [400, "usage"]);
  assert.deepEqual(statusOf(edit.ErrInvalid), [400, "usage"]);
  assert.deepEqual(statusOf(api.ErrUsage), [400, "usage"]);
  assert.deepEqual(statusOf(api.usagef("a missing field")), [400, "usage"]);
  assert.deepEqual(statusOf(store.ErrNotInitialized), [503, "config"]);
  assert.deepEqual(statusOf(version.ErrSchemaMismatch), [503, "config"]);
  assert.deepEqual(statusOf(new Error("something else")), [500, "error"]);
});

// The listener is separate from serving so that `tdo serve` can print the
// port the kernel chose. Port 0 has to come back as the real one.
test("the listener reports the port it actually got", async () => {
  const ln = await Listen("127.0.0.1:0");
  try {
    assert.match(ln.addr(), /^127\.0\.0\.1:\d+$/);
    assert.notEqual(ln.addr(), "127.0.0.1:0");
  } finally {
    await ln.close();
  }
});

// A port already in use is the common case `tdo serve` turns into a usage
// error, so Listen has to fail rather than pick another one.
test("a port already in use is refused", async () => {
  const first = await Listen("127.0.0.1:0");
  try {
    await assert.rejects(Listen(first.addr()));
  } finally {
    await first.close();
  }
});

// Serving stops when the signal is aborted, which is what Ctrl-C does in
// `tdo serve`: the listener goes and the store is closed the way every other
// command closes it.
test("an aborted signal stops the server", async () => {
  const st = open(MemoryPath);
  await st.init();
  const srv = New(st);
  const ln = await Listen("127.0.0.1:0");
  const addr = ln.addr();
  const stop = new AbortController();
  const serving = srv.serve(ln, stop.signal);
  const before = await fetch(`http://${addr}/`);
  await before.text();
  assert.equal(before.status, 200);

  stop.abort();
  await serving;
  await assert.rejects(fetch(`http://${addr}/`));
  await st.close();
});

test("the server dialog's settings are read-only here, and say how to change them", async (t) => {
  const h = await Harness.start(t);

  const res = await fetch(`${h.base}/api/settings`);
  assert.equal(res.status, 200);
  const settings = (await res.json()) as { editable: boolean; url: string; token_set: boolean; notice: string };
  assert.equal(settings.editable, false);
  assert.equal(settings.token_set, false);
  assert.match(settings.notice, /tdo config set/);
  assert.match(settings.notice, /tdo login/);

  // There is no way to write it: the connection is the CLI's configuration.
  const put = await fetch(`${h.base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", [TokenHeader]: h.srv.token },
    body: JSON.stringify({ url: "libsql://example.turso.io", token: "TOKEN_GOES_HERE", remember: true }),
  });
  await put.text();
  assert.equal(put.status, 405);
});
