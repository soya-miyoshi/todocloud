// The endpoint half of the viewer's tests: the state snapshot, every write,
// and the refusals. What is asserted here is that the API answers what the
// shared layer answers — a tree rule, a repeat, an availability — rather than
// anything this directory decides for itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import { New as newID } from "@todocloud/core/id";
import { newEvent } from "@todocloud/core/store/event";
import { KeyAvailable, KeyBlockedBy, KeyNextReview } from "@todocloud/core/task";

import { Harness, errorCode, pinnedNow } from "./testsupport.ts";

/** list reads an array out of a payload, failing rather than coercing. */
function list(payload: Record<string, unknown> | undefined, key: string): unknown[] {
  const raw = payload?.[key];
  if (!Array.isArray(raw)) {
    return assert.fail(`${key} is not an array in ${JSON.stringify(payload)}`);
  }
  return raw;
}

// Go's TestTheStateResponseCarriesTheDerivedKeys is the contract the page is
// written against: one snapshot, with the three derived keys of §3.3 and §3.5
// already computed, so the browser never recomputes an availability rule in
// JavaScript.
test("the state response carries the derived keys", async (t) => {
  const h = await Harness.start(t);
  await h.add({ title: "write the viewer" });

  const { status, payload } = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  assert.equal(status, 200, JSON.stringify(payload));
  for (const key of ["tasks", "count", "perspectives", "tags", "store", "now"]) {
    assert.ok(payload !== undefined && key in payload, `the state response is missing ${key}`);
  }
  assert.equal(payload?.["now"], "2026-03-02T09:00:00Z");
  assert.equal(payload?.["store"], h.st.describe());
  assert.equal(payload?.["count"], 1);

  const one = (await h.tasks())[0];
  assert.ok(one !== undefined);
  for (const key of [KeyAvailable, KeyBlockedBy, KeyNextReview]) {
    assert.ok(key in one, `a task in the state response is missing the derived key ${key}`);
  }
  assert.equal(one[KeyAvailable], true, "a plain captured task should be available");
});

// A state response is one snapshot: the count and the listing are the same
// read, so the sidebar cannot contradict the list below it.
test("the state response counts what it lists", async (t) => {
  const h = await Harness.start(t);
  const project = await h.add({ title: "ship v1", kind: "project" });
  await h.add({ title: "write the docs", parent_id: project });

  const { payload } = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  assert.equal(payload?.["count"], list(payload, "tasks").length);
  assert.equal(payload?.["count"], 2);
});

// Go's TestCompletingARepeatingItemCreatesItsSuccessor is the one write that
// creates a row nobody asked for, and the reason completing is its own
// endpoint rather than a status change.
test("completing a repeating item creates its successor", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({
    title: "water the plants",
    due_at: "2026-03-03",
    repeat: "1w",
  });

  const done = await h.do("POST", `/api/tasks/${taskID}/done`, {});
  assert.equal(done.status, 200, JSON.stringify(done.payload));
  assert.equal(
    list(done.payload, "repeated").length,
    1,
    "completing a repeating item should report one successor",
  );
  assert.equal((await h.find(taskID))["status"], "done", "the instance should be done");

  // And the status endpoint refuses to be the way round it.
  const sideways = await h.do("POST", `/api/tasks/${taskID}/status`, { status: "done" });
  assert.equal(sideways.status, 400, "completing through the status endpoint");
  assert.equal(errorCode(sideways), "usage");
});

// Completing with no payload at all is what the viewer sends, so an absent
// body has to mean every default rather than a malformed request.
test("completing with no body at all is accepted", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "take the bins out", repeat: "1d", due_at: "2026-03-03" });
  const done = await h.send("POST", `/api/tasks/${taskID}/done`, undefined, h.srv.token, "");
  assert.equal(done.status, 200, done.text);
  assert.equal(list(done.payload, "repeated").length, 1);
});

// no_repeat is the other half of `tdo done --no-repeat`: the instance closes
// and the series stops there.
test("no_repeat closes the item without a successor", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "renew the passport", repeat: "1y", due_at: "2026-03-03" });
  const done = await h.do("POST", `/api/tasks/${taskID}/done`, { no_repeat: true });
  assert.equal(done.status, 200, done.text);
  assert.equal(list(done.payload, "repeated").length, 0);
  assert.equal((await h.find(taskID))["status"], "done");
});

// Go's TestTheTreeRulesAreTheStoresAnswer: the viewer offers only legal
// parents, but an id can arrive from anywhere, so the refusal has to come
// from the store and arrive as a bad request rather than a server failure.
test("the tree rules are the store's answer", async (t) => {
  const h = await Harness.start(t);
  const project = await h.add({ title: "ship v1", kind: "project" });
  const other = await h.add({ title: "ship v2", kind: "project" });

  const underProject = await h.do("POST", `/api/tasks/${project}/move`, { parent_id: other });
  assert.equal(underProject.status, 400, `a project under a project: ${underProject.text}`);
  const intoItself = await h.do("POST", `/api/tasks/${project}/move`, { parent_id: project });
  assert.equal(intoItself.status, 400, "a move into itself");
  const unknown = await h.do("POST", `/api/tasks/${project}/move`, {
    parent_id: "0".repeat(26),
  });
  assert.equal(unknown.status, 404, "a move under an unknown parent");
  assert.equal(errorCode(unknown), "not_found");
});

// An empty parent_id is how the viewer unfiles something: the task goes back
// to the top level, which for a task is the inbox.
test("an empty parent unfiles an item", async (t) => {
  const h = await Harness.start(t);
  const project = await h.add({ title: "ship v1", kind: "project" });
  const child = await h.add({ title: "write the docs", parent_id: project });
  assert.equal((await h.find(child))["parent_id"], project);

  const moved = await h.do("POST", `/api/tasks/${child}/move`, { parent_id: "" });
  assert.equal(moved.status, 200, moved.text);
  // An unfiled task's parent_id is null in the task shape, not an empty
  // string: see `task.toJSON`, which is where the wire spelling is decided.
  assert.equal((await h.find(child))["parent_id"], null);
});

// A parent given on creation is resolved rather than trusted, so an id the
// store does not know is a 404 and not a row with a dangling parent.
test("creating under an unknown parent is a 404", async (t) => {
  const h = await Harness.start(t);
  const created = await h.do("POST", "/api/tasks", {
    title: "orphan",
    parent_id: "0".repeat(26),
  });
  assert.equal(created.status, 404, created.text);
  assert.equal((await h.tasks()).length, 0);
});

// Go's TestARejectedEditChangesNothing: the shared layer validates a copy,
// and the refusal has to reach the browser as a bad request naming the field.
test("a rejected edit changes nothing", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "original" });

  for (const [name, body] of [
    ["an empty title", { title: "   " }],
    ["a priority out of range", { priority: 9 }],
    ["a reserved field", { set: { status: "done" } }],
    ["an unknown key", { nonesuch: 1 }],
    ["nothing at all", {}],
  ] as const) {
    await t.test(name, async () => {
      const res = await h.do("PATCH", `/api/tasks/${taskID}`, body);
      assert.equal(res.status, 400, `${name}: ${res.text}`);
      assert.equal(errorCode(res), "usage");
      assert.equal((await h.find(taskID))["title"], "original", "the stored item changed anyway");
    });
  }
});

// A key of the wrong type is the same class of refusal: Go's struct tags
// turned it down, and an ignored key would be a silent half-applied edit.
test("a field of the wrong type is a usage error", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "original" });

  for (const body of [
    { title: 7 },
    { flagged: "yes" },
    { priority: 1.5 },
    { tags: "home" },
    { tags: ["home", 3] },
    { set: ["not", "an", "object"] },
  ]) {
    const res = await h.do("PATCH", `/api/tasks/${taskID}`, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    assert.equal(errorCode(res), "usage");
  }
  // A body that is not an object at all, and one that is not JSON.
  for (const raw of ["[1,2,3]", "null", "not json"]) {
    const res = await fetch(`${h.base}/api/tasks/${taskID}`, {
      method: "PATCH",
      headers: { "x-tdo-token": h.srv.token, "content-type": "application/json" },
      body: raw,
    });
    await res.text();
    assert.equal(res.status, 400, raw);
  }
  assert.equal((await h.find(taskID))["title"], "original");
});

// An edit that only flags goes through the flag operation, because flagging
// is its own write in the shared layer and the inspector sends one request.
test("an edit may carry only the flag", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "call the plumber" });
  const flagged = await h.do("PATCH", `/api/tasks/${taskID}`, { flagged: true });
  assert.equal(flagged.status, 200, flagged.text);
  assert.equal((await h.find(taskID))["flagged"], true);

  // And the flag together with a field: both land, in one answer.
  const both = await h.do("PATCH", `/api/tasks/${taskID}`, { flagged: false, note: "rang twice" });
  assert.equal(both.status, 200, both.text);
  const stored = await h.find(taskID);
  assert.equal(stored["flagged"], false);
  assert.equal(stored["note"], "rang twice");
});

// Clearing a note is not the same request as leaving it alone, which is the
// distinction `tdo edit --note ""` depends on.
test("an empty string clears a note and an absent key leaves it", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "file the receipts", note: "in the drawer" });
  const untouched = await h.do("PATCH", `/api/tasks/${taskID}`, { title: "file the receipts" });
  assert.equal(untouched.status, 200, untouched.text);
  assert.equal((await h.find(taskID))["note"], "in the drawer");

  const cleared = await h.do("PATCH", `/api/tasks/${taskID}`, { note: "" });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal((await h.find(taskID))["note"], null);
});

// The status endpoint is the shared layer's, for the three statuses that are
// not a completion.
test("the status endpoint sets the three open statuses", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "wait for the quote" });
  for (const status of ["on_hold", "dropped", "active"]) {
    const res = await h.do("POST", `/api/tasks/${taskID}/status`, { status });
    assert.equal(res.status, 200, `${status}: ${res.text}`);
    assert.equal((await h.find(taskID))["status"], status);
  }
  const nonsense = await h.do("POST", `/api/tasks/${taskID}/status`, { status: "finished" });
  assert.equal(nonsense.status, 400, nonsense.text);
});

// Go's TestRemovingAContainerTakesItsSubtree, and it leaves a tombstone
// rather than deleting: there is no purge in this API at all.
test("removing a container takes its subtree", async (t) => {
  const h = await Harness.start(t);
  const project = await h.add({ title: "ship v1", kind: "project" });
  const child = await h.add({ title: "write the docs", parent_id: project });

  const removed = await h.do("DELETE", `/api/tasks/${project}`);
  assert.equal(removed.status, 200, removed.text);
  assert.equal(
    removed.payload?.["count"],
    2,
    `removing a container should report the subtree: ${removed.text}`,
  );
  for (const taskID of [project, child]) {
    const stored = await h.st.get(taskID);
    assert.notEqual(stored.deletedAt, undefined, `${taskID} should carry a tombstone`);
  }
  // A tombstoned item is gone from the viewer's snapshot: `tdo ls --deleted`
  // is where it still shows.
  assert.equal((await h.tasks()).length, 0, "the state response should not list tombstones");
});

// Go's TestABadIDIsAUsageError, not a 404 and not a 500: the page always has
// the whole id, so anything else is a malformed request.
test("a bad id is a usage error and an unknown id is a 404", async (t) => {
  const h = await Harness.start(t);
  const malformed = await h.do("POST", "/api/tasks/notanid/flag", { flagged: true });
  assert.equal(malformed.status, 400, "a malformed id");
  assert.equal(errorCode(malformed), "usage");

  const unknown = await h.do("POST", `/api/tasks/${"0".repeat(26)}/flag`, { flagged: true });
  assert.equal(unknown.status, 404, "an unknown id");
  assert.equal(errorCode(unknown), "not_found");
});

// A prefix is for a person typing; the page always has the whole id, so a
// prefix is a malformed request rather than a lookup.
test("an id prefix is not accepted", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "no shortcuts here" });
  const res = await h.do("POST", `/api/tasks/${taskID.slice(0, 6)}/flag`, { flagged: true });
  assert.equal(res.status, 400, res.text);
});

// Go's TestEveryDateSpellingTheCLITakes: the API and the flags accept the
// same values, because both go through the shared parser.
test("every date spelling the CLI takes", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "pay the invoice" });

  const dated = await h.do("POST", `/api/tasks/${taskID}/date`, {
    field: "due",
    at: "2026-04-01",
  });
  assert.equal(dated.status, 200, `a date-only due: ${dated.text}`);
  assert.equal((await h.find(taskID))["due_at"], "2026-04-01T00:00:00Z");

  // An emptied field in the browser clears the date, which is what `--clear`
  // does at the command line.
  const cleared = await h.do("POST", `/api/tasks/${taskID}/date`, { field: "due", at: "" });
  assert.equal(cleared.status, 200, "clearing a date should be accepted");
  assert.equal((await h.find(taskID))["due_at"], null, "due_at after clearing");

  const unparseable = await h.do("POST", `/api/tasks/${taskID}/date`, {
    field: "due",
    at: "next tuesday",
  });
  assert.equal(unparseable.status, 400, "an unparseable date should be a bad request");

  const unknownField = await h.do("POST", `/api/tasks/${taskID}/date`, {
    field: "someday",
    at: "2026-04-01",
  });
  assert.equal(unknownField.status, 400, "an unknown date field should be a bad request");

  // The defer date is the other field, and a deferred item is not available:
  // the browser is told so rather than working it out.
  const deferred = await h.do("POST", `/api/tasks/${taskID}/date`, {
    field: "defer",
    at: "2026-04-01",
  });
  assert.equal(deferred.status, 200, deferred.text);
  const stored = await h.find(taskID);
  assert.equal(stored[KeyAvailable], false);
  assert.equal((stored[KeyBlockedBy] as Record<string, unknown>)["rule"], "deferred");
});

// A creation takes every field in the spellings a browser can send, and the
// answer is the listing shape with the one task in it.
test("a creation takes the fields a browser sends", async (t) => {
  const h = await Harness.start(t);
  const project = await h.add({ title: "ship v1", kind: "project" });
  const created = await h.do("POST", "/api/tasks", {
    kind: "task",
    title: "  write the docs  ",
    parent_id: project,
    note: "the installable bit",
    tags: ["Writing", "writing", " home "],
    flagged: true,
    due_at: "2026-04-01",
    estimate: "1h30m",
    priority: 2,
    set: { owner: "me" },
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.payload?.["count"], 1);
  const one = list(created.payload, "tasks")[0] as Record<string, unknown>;
  assert.equal(one["title"], "write the docs");
  assert.equal(one["parent_id"], project);
  assert.equal(one["flagged"], true);
  assert.equal(one["due_at"], "2026-04-01T00:00:00Z");
  assert.equal(one["estimated_minutes"], 90);
  assert.equal(one["priority"], 2);
  assert.equal(one["owner"], "me");
  // The tags went through the shared normalizer: trimmed, deduped
  // case-insensitively keeping the first spelling, and sorted.
  assert.deepEqual(one["tags"], ["home", "Writing"]);
  assert.equal(one["created_at"], "2026-03-02T09:00:00Z");
  assert.equal(one[KeyAvailable], true);
});

// A creation with no title is the one refusal this module makes before the
// shared layer sees the request, and an unknown kind is the other.
test("a creation needs a title and a known kind", async (t) => {
  const h = await Harness.start(t);
  for (const body of [{}, { title: "   " }, { title: "x", kind: "milestone" }]) {
    const res = await h.do("POST", "/api/tasks", body);
    assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
    assert.equal(errorCode(res), "usage");
  }
  assert.equal((await h.tasks()).length, 0);
});

// An unparseable estimate or repeat is the shared parser's refusal, and it
// arrives as a bad request naming what it could not read.
test("an unreadable estimate or repeat is a usage error", async (t) => {
  const h = await Harness.start(t);
  for (const body of [
    { title: "x", estimate: "a while" },
    { title: "x", repeat: "whenever" },
  ]) {
    const res = await h.do("POST", "/api/tasks", body);
    assert.equal(res.status, 400, `${JSON.stringify(body)}: ${res.text}`);
  }
});

// Completing the last child of a container closes the container, and the
// answer says so: the viewer refetches afterwards, but a silent one would be
// a surprise later.
test("a container that closes with its last child is reported", async (t) => {
  const h = await Harness.start(t);
  const project = await h.add({ title: "ship v1", kind: "project" });
  // completed_by_children is a reserved field, so the API refuses to set it
  // (see the rejected-edit cases); it is set through the store, which is what
  // `tdo project --completed-by-children` does.
  const container = await h.st.get(project);
  container.completedByChildren = true;
  await h.st.update(container);
  const child = await h.add({ title: "the only task", parent_id: project });

  const done = await h.do("POST", `/api/tasks/${child}/done`, {});
  assert.equal(done.status, 200, done.text);
  const closed = list(done.payload, "completed_with_last");
  assert.equal(closed.length, 1, done.text);
  assert.equal((closed[0] as Record<string, unknown>)["id"], project);
  // The rows nobody asked for carry null derived keys rather than a claim
  // about availability that was never computed.
  assert.equal((closed[0] as Record<string, unknown>)[KeyAvailable], null);
  assert.equal((closed[0] as Record<string, unknown>)[KeyNextReview], null);
});

// The tags and the perspectives come back in the same snapshot, in the keys
// the page reads them from.
test("the snapshot carries the tags and the perspectives", async (t) => {
  const h = await Harness.start(t);
  await h.add({ title: "mow the lawn", tags: ["home"] });
  await h.st.setTagStatus("home", "on_hold", pinnedNow);
  await h.st.savePerspective({
    name: "Today",
    filter: (await import("@todocloud/core/store/filter")).filterFromJSON({}),
    createdAt: pinnedNow,
    updatedAt: pinnedNow,
  });

  const { payload } = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  const tags = list(payload, "tags") as Record<string, unknown>[];
  assert.deepEqual(tags, [{ name: "home", status: "on_hold", count: 1 }]);
  const perspectives = list(payload, "perspectives") as Record<string, unknown>[];
  assert.equal(perspectives.length, 1);
  assert.equal(perspectives[0]?.["name"], "Today");
  // The keys are Go's struct tags, not the ported type's field names: the
  // page is written against the wire shape.
  assert.equal(perspectives[0]?.["created_at"], "2026-03-02T09:00:00Z");
  assert.ok("filter" in (perspectives[0] ?? {}));

  // A tag on hold takes its tasks out of the way, and the snapshot says so.
  const one = (await h.tasks())[0];
  assert.equal(one?.[KeyAvailable], false);
  assert.equal((one?.[KeyBlockedBy] as Record<string, unknown>)["rule"], "tag_status");
});

// A body over the cap is cut rather than read, and the cut JSON is a usage
// error: an unbounded read is an easy way to make a local process eat memory.
test("an oversized body is refused", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "original" });
  const res = await h.do("PATCH", `/api/tasks/${taskID}`, { note: "x".repeat(2 << 20) });
  assert.equal(res.status, 400, res.text);
  assert.equal((await h.find(taskID))["note"], null);
});

// --- saved perspectives --------------------------------------------------

// The point of the endpoint: the store runs the stored filter. If the page
// could be trusted to evaluate a Filter in JavaScript there would be no
// reason for this route to exist, and two implementations of one query to
// keep in step — which is the drift this project was rewritten to be rid of.
test("running a saved perspective answers with what the store matched", async (t) => {
  const h = await Harness.start(t);
  const wanted = await h.add({ title: "call the plumber", flagged: true });
  await h.add({ title: "not flagged" });
  const saved = await h.do("POST", "/api/perspectives", {
    name: "Flagged",
    filter: { flagged: true },
  });
  assert.equal(saved.status, 200, saved.text);

  const { status, payload } = await h.send("GET", "/api/perspectives/Flagged", undefined, h.srv.token, "");
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload?.["name"], "Flagged");
  assert.equal(payload?.["count"], 1);
  const tasks = list(payload, "tasks") as Record<string, unknown>[];
  assert.equal(tasks[0]?.["id"], wanted);
  // The filter comes back too, so the editor can open one without a second
  // request.
  assert.deepEqual(payload?.["filter"], { flagged: true });
});

// A name is typed by a person, so it may hold a space or a `#`; the route
// decodes it rather than refusing it.
test("a perspective name survives the round trip through the URL", async (t) => {
  const h = await Harness.start(t);
  await h.do("POST", "/api/perspectives", { name: "at work #now", filter: {} });
  const path = `/api/perspectives/${encodeURIComponent("at work #now")}`;
  const { status, payload } = await h.send("GET", path, undefined, h.srv.token, "");
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload?.["name"], "at work #now");
});

// Dropping an unknown key would widen the saved query instead of narrowing
// it, and nothing would say so. The refusal is the behaviour.
test("a filter carrying an unknown field is refused", async (t) => {
  const h = await Harness.start(t);
  const res = await h.do("POST", "/api/perspectives", {
    name: "newer",
    filter: { flagged: true, invented_by_a_newer_tdo: true },
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(errorCode(res), "usage");
  assert.match(res.text, /unknown field/);
  const after = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  assert.equal(list(after.payload, "perspectives").length, 0, "nothing is stored by a refused save");
});

// A filter the providers could not honour is refused at the door rather
// than stored and failed on every later run.
test("a filter that would not validate is refused", async (t) => {
  const h = await Harness.start(t);
  const res = await h.do("POST", "/api/perspectives", {
    name: "bad order",
    filter: { order: "sideways" },
  });
  assert.equal(res.status, 400, res.text);
  assert.equal(errorCode(res), "usage");
});

test("a perspective needs a name", async (t) => {
  const h = await Harness.start(t);
  const res = await h.do("POST", "/api/perspectives", { name: "   ", filter: {} });
  assert.equal(res.status, 400, res.text);
  assert.equal(errorCode(res), "usage");
});

test("saving replaces a perspective of the same name", async (t) => {
  const h = await Harness.start(t);
  await h.do("POST", "/api/perspectives", { name: "Today", filter: { flagged: true } });
  await h.do("POST", "/api/perspectives", { name: "Today", filter: { flagged: false } });
  const { payload } = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  const saved = list(payload, "perspectives") as Record<string, unknown>[];
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0]?.["filter"], { flagged: false });
});

test("removing a perspective leaves nothing to run", async (t) => {
  const h = await Harness.start(t);
  await h.do("POST", "/api/perspectives", { name: "Today", filter: {} });
  const gone = await h.do("DELETE", "/api/perspectives/Today");
  assert.equal(gone.status, 200, gone.text);
  const { status } = await h.send("GET", "/api/perspectives/Today", undefined, h.srv.token, "");
  assert.equal(status, 404);
});

// Saving and removing change the store, so they are writes and carry the
// token; running one does not.
test("saving a perspective without the write token is refused", async (t) => {
  const h = await Harness.start(t);
  const res = await h.send("POST", "/api/perspectives", { name: "Today", filter: {} }, "", "application/json");
  assert.equal(res.status, 403, res.text);
  const after = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  assert.equal(list(after.payload, "perspectives").length, 0);
});

// --- placing one item beside another -------------------------------------

// Order is not decoration in a sequential project: a child's position is the
// order its actions become available (§3.3), which is why the viewer can
// change it at all.
test("a reorder puts an item before its anchor", async (t) => {
  const h = await Harness.start(t);
  const project = await h.add({ kind: "project", title: "Ship it" });
  const first = await h.add({ title: "one", parent_id: project });
  const second = await h.add({ title: "two", parent_id: project });

  const res = await h.do("POST", `/api/tasks/${second}/reorder`, { anchor: first, where: "before" });
  assert.equal(res.status, 200, res.text);

  const order = (await h.tasks())
    .filter((x) => x["parent_id"] === project)
    .map((x) => x["title"]);
  assert.deepEqual(order, ["two", "one"]);
});

// `tdo mv --after` moves an item into the anchor's container when the anchor
// lives somewhere else, and the endpoint is that command: a drop on the edge
// of a row in another project is both a move and a placement.
test("placing an item beside an anchor elsewhere moves it there", async (t) => {
  const h = await Harness.start(t);
  const home = await h.add({ kind: "project", title: "Home" });
  const work = await h.add({ kind: "project", title: "Work" });
  const anchor = await h.add({ title: "anchor", parent_id: work });
  const moving = await h.add({ title: "moving", parent_id: home });

  const res = await h.do("POST", `/api/tasks/${moving}/reorder`, { anchor, where: "after" });
  assert.equal(res.status, 200, res.text);
  assert.equal((await h.find(moving))["parent_id"], work);
});

test("a reorder needs a known placement and a real anchor", async (t) => {
  const h = await Harness.start(t);
  const one = await h.add({ title: "one" });
  const two = await h.add({ title: "two" });

  const sideways = await h.do("POST", `/api/tasks/${two}/reorder`, { anchor: one, where: "sideways" });
  assert.equal(sideways.status, 400, sideways.text);
  assert.equal(errorCode(sideways), "usage");

  const itself = await h.do("POST", `/api/tasks/${two}/reorder`, { anchor: two, where: "after" });
  assert.equal(itself.status, 400, itself.text);
});

test("a reorder without the write token is refused", async (t) => {
  const h = await Harness.start(t);
  const one = await h.add({ title: "one" });
  const two = await h.add({ title: "two" });
  const res = await h.send("POST", `/api/tasks/${two}/reorder`, { anchor: one, where: "before" }, "", "application/json");
  assert.equal(res.status, 403, res.text);
});

// --- a tag's name --------------------------------------------------------

// The endpoint exists for the same reason the perspective one does: moving
// every task from one tag to another is the store's job, and a page that
// walked the tasks itself would be a second implementation of `tdo tag
// rename`.
test("renaming a tag moves every task carrying it", async (t) => {
  const h = await Harness.start(t);
  const first = await h.add({ title: "mow the lawn", tags: ["home"] });
  const second = await h.add({ title: "fix the gate", tags: ["home", "errand"] });

  const res = await h.do("PATCH", "/api/tags/home", { name: "house" });
  assert.equal(res.status, 200, res.text);
  const renamed = list(res.payload, "tags") as Record<string, unknown>[];
  assert.deepEqual(renamed, [{ name: "house", status: "active", count: 2 }]);

  assert.deepEqual((await h.find(first))["tags"], ["house"]);
  assert.deepEqual((await h.find(second))["tags"], ["errand", "house"]);
});

// A tag keeps the status it already had, so renaming one into it does not
// quietly take a hold off.
test("renaming into an existing tag keeps that tag's status", async (t) => {
  const h = await Harness.start(t);
  await h.add({ title: "call the plumber", tags: ["phone"] });
  await h.st.setTagStatus("waiting", "on_hold", pinnedNow);

  const res = await h.do("PATCH", "/api/tags/phone", { name: "waiting" });
  assert.equal(res.status, 200, res.text);
  const renamed = list(res.payload, "tags") as Record<string, unknown>[];
  assert.equal(renamed[0]?.["status"], "on_hold");
});

// A tag is typed, so a name may hold a space or a `#`; the page encodes it
// and `tagPath` decodes it.
test("a tag name survives the round trip through the URL", async (t) => {
  const h = await Harness.start(t);
  await h.add({ title: "read the spec", tags: ["at work #now"] });
  const res = await h.do("PATCH", `/api/tags/${encodeURIComponent("at work #now")}`, {
    name: "at the office",
  });
  assert.equal(res.status, 200, res.text);
  assert.equal((list(res.payload, "tags")[0] as Record<string, unknown>)["name"], "at the office");
});

test("renaming a tag needs a destination and a tag that exists", async (t) => {
  const h = await Harness.start(t);
  await h.add({ title: "mow the lawn", tags: ["home"] });

  const blank = await h.do("PATCH", "/api/tags/home", { name: "   " });
  assert.equal(blank.status, 400, blank.text);
  assert.equal(errorCode(blank), "usage");

  const unknown = await h.do("PATCH", "/api/tags/nowhere", { name: "somewhere" });
  assert.equal(unknown.status, 404, unknown.text);

  // Nothing was renamed by either refusal.
  const { payload } = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  const tags = list(payload, "tags") as Record<string, unknown>[];
  assert.deepEqual(tags.map((g) => g["name"]), ["home"]);
});

test("renaming a tag without the write token is refused", async (t) => {
  const h = await Harness.start(t);
  await h.add({ title: "mow the lawn", tags: ["home"] });
  const res = await h.send("PATCH", "/api/tags/home", { name: "house" }, "", "application/json");
  assert.equal(res.status, 403, res.text);
  const { payload } = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  assert.equal((list(payload, "tags")[0] as Record<string, unknown>)["name"], "home");
});

// --- a task's own fields -------------------------------------------------

// `set_text` is what the inspector's field rows send: the text a person
// typed, typed by the same `parseValue` that reads `tdo edit --set KEY=VALUE`
// — so a field typed into a browser and the same field typed at a shell end
// up as the same stored value, rather than as a number in one and a string
// in the other.
test("set_text types a value the way --set types it", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "review the contract" });

  const res = await h.do("PATCH", `/api/tasks/${taskID}`, {
    set_text: {
      client: "acme",
      estimate: "3",
      ref: "3.0.1",
      billable: "true",
      plan: '{"rounds":2}',
      blank: "",
    },
  });
  assert.equal(res.status, 200, res.text);

  const after = await h.find(taskID);
  assert.equal(after["client"], "acme");
  assert.equal(after["estimate"], 3);
  assert.equal(after["ref"], "3.0.1");
  assert.equal(after["billable"], true);
  assert.deepEqual(after["plan"], { rounds: 2 });
  assert.equal(after["blank"], "");
});

// `set` carries JSON and wins the keys the two share, so a caller that has
// a value does not have to spell it as text to send it.
test("set wins over set_text on a key they share", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "review the contract" });
  const res = await h.do("PATCH", `/api/tasks/${taskID}`, {
    set: { estimate: 7 },
    set_text: { estimate: "3", client: "acme" },
  });
  assert.equal(res.status, 200, res.text);
  const after = await h.find(taskID);
  assert.equal(after["estimate"], 7);
  assert.equal(after["client"], "acme");
});

test("set_text refuses a value that is not a string and a reserved key", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "review the contract" });

  const typed = await h.do("PATCH", `/api/tasks/${taskID}`, { set_text: { estimate: 3 } });
  assert.equal(typed.status, 400, typed.text);
  assert.equal(errorCode(typed), "usage");

  const reserved = await h.do("PATCH", `/api/tasks/${taskID}`, { set_text: { status: "done" } });
  assert.equal(reserved.status, 400, reserved.text);
  assert.equal((await h.find(taskID))["status"], "active");
});

// --- events ---------------------------------------------------------------

/** event stores an event directly: the page cannot create one, the CLI does. */
async function event(h: Harness, title: string): Promise<string> {
  const e = newEvent(newID(), title, new Date(Date.UTC(2026, 2, 1)));
  await h.st.addEvent(e);
  return e.id;
}

test("the state response lists the events and who waits for them", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "send the order" });
  const eventID = await event(h, "vendor reply");
  await h.st.setWaits(taskID, [eventID]);

  const { payload } = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  const events = list(payload, "events") as Record<string, unknown>[];
  assert.equal(events.length, 1);
  assert.equal(events[0]?.["id"], eventID);
  assert.equal(events[0]?.["status"], "pending");
  assert.deepEqual(events[0]?.["waiting"], [taskID], "the event says who waits for it");

  const waiting = await h.find(taskID);
  assert.equal(waiting[KeyAvailable], false, "the waiting task is blocked in the same snapshot");
  assert.deepEqual((waiting[KeyBlockedBy] as Record<string, unknown>)["rule"], "event");
  assert.deepEqual(waiting["waits_on"], [eventID]);
});

test("an event occurring releases what waits for it, and says so", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "send the order" });
  const eventID = await event(h, "vendor reply");
  await h.st.setWaits(taskID, [eventID]);

  const res = await h.do("POST", `/api/events/${eventID}/status`, { status: "occurred" });
  assert.equal(res.status, 200, res.text);
  const released = list(res.payload, "released") as Record<string, unknown>[];
  assert.deepEqual(released.map((x) => x["id"]), [taskID]);
  assert.equal(released[0]?.[KeyAvailable], true);
  assert.equal((await h.find(taskID))[KeyAvailable], true, "and the next snapshot agrees");

  const back = await h.do("POST", `/api/events/${eventID}/status`, { status: "pending" });
  assert.equal(back.status, 200, back.text);
  assert.deepEqual((list(back.payload, "held") as Record<string, unknown>[]).map((x) => x["id"]), [taskID]);
  assert.equal((await h.find(taskID))[KeyAvailable], false);
});

test("the event status endpoint refuses what it should", async (t) => {
  const h = await Harness.start(t);
  const eventID = await event(h, "vendor reply");
  const bad = await h.do("POST", `/api/events/${eventID}/status`, { status: "done" });
  assert.equal(bad.status, 400, "done is a task status: " + bad.text);
  const notID = await h.do("POST", "/api/events/not-an-id/status", { status: "occurred" });
  assert.equal(notID.status, 400, notID.text);
  const unknown = await h.do("POST", `/api/events/${newID()}/status`, { status: "occurred" });
  assert.equal(unknown.status, 404, unknown.text);
  const noToken = await h.send("POST", `/api/events/${eventID}/status`, { status: "occurred" }, "", "");
  assert.notEqual(noToken.status, 200, "a write without the token is refused");
});

test("an event's title, note, expected date and project are editable", async (t) => {
  const h = await Harness.start(t);
  const projectID = await h.add({ title: "launch", kind: "project" });
  const eventID = await event(h, "vendor reply");

  const res = await h.do("PATCH", `/api/events/${eventID}`, {
    title: "会長の返信（屋上か個人ベランダか）",
    note: "理事会で確認する",
    expected_at: "2026-11-05",
    project_id: projectID,
  });
  assert.equal(res.status, 200, res.text);
  const [e] = list(res.payload, "events") as Record<string, unknown>[];
  assert.equal(e?.["title"], "会長の返信（屋上か個人ベランダか）");
  assert.equal(e?.["note"], "理事会で確認する");
  assert.equal(e?.["expected_at"], "2026-11-05T00:00:00Z");
  assert.equal(e?.["project_id"], projectID);

  // it is what the store holds, and the next snapshot says so
  const stored = await h.st.getEvent(eventID);
  assert.equal(stored.projectID, projectID);
  const state = await h.send("GET", "/api/state", undefined, h.srv.token, "");
  assert.equal((list(state.payload, "events")[0] as Record<string, unknown>)["project_id"], projectID);

  // a key that is absent leaves the field alone, an empty one clears it
  const only = await h.do("PATCH", `/api/events/${eventID}`, { note: "" });
  assert.equal(only.status, 200, only.text);
  const after = await h.st.getEvent(eventID);
  assert.equal(after.note, "", "an empty string clears the note");
  assert.equal(after.title, "会長の返信（屋上か個人ベランダか）", "and what was not sent is untouched");
  assert.equal(after.projectID, projectID);
  const unfiled = await h.do("PATCH", `/api/events/${eventID}`, { project_id: "", expected_at: "" });
  assert.equal(unfiled.status, 200, unfiled.text);
  const free = await h.st.getEvent(eventID);
  assert.equal(free.projectID, "", "an empty project takes it out of its project");
  assert.equal(free.expectedAt, undefined, "an empty date clears it");
});

test("an event edit refuses what it should and changes nothing", async (t) => {
  const h = await Harness.start(t);
  const taskID = await h.add({ title: "a task" });
  const eventID = await event(h, "vendor reply");

  const blank = await h.do("PATCH", `/api/events/${eventID}`, { title: "   " });
  assert.equal(blank.status, 400, "a blank title: " + blank.text);
  const notProject = await h.do("PATCH", `/api/events/${eventID}`, { project_id: taskID });
  assert.equal(notProject.status, 400, "a task is not a project: " + notProject.text);
  const ghost = await h.do("PATCH", `/api/events/${eventID}`, { project_id: newID() });
  assert.equal(ghost.status, 404, "a project that does not exist: " + ghost.text);
  const badDate = await h.do("PATCH", `/api/events/${eventID}`, { expected_at: "next week" });
  assert.equal(badDate.status, 400, badDate.text);
  const unknownKey = await h.do("PATCH", `/api/events/${eventID}`, { status: "occurred" });
  assert.equal(unknownKey.status, 400, "status has its own endpoint: " + unknownKey.text);
  const notID = await h.do("PATCH", "/api/events/not-an-id", { title: "x" });
  assert.equal(notID.status, 400, notID.text);
  const unknown = await h.do("PATCH", `/api/events/${newID()}`, { title: "x" });
  assert.equal(unknown.status, 404, unknown.text);

  const stored = await h.st.getEvent(eventID);
  assert.equal(stored.title, "vendor reply", "none of the refused edits changed anything");
  assert.equal(stored.projectID, "");
  assert.equal(stored.status, "pending");
});
