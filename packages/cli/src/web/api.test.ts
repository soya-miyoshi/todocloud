// The endpoint half of the viewer's tests: the state snapshot, every write,
// and the refusals. What is asserted here is that the API answers what the
// shared layer answers — a tree rule, a repeat, an availability — rather than
// anything this directory decides for itself.

import { test } from "node:test";
import assert from "node:assert/strict";

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
